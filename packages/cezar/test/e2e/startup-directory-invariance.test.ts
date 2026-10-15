import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
// This file lives at packages/cezar/test/e2e; the built CLI it spawns is the
// workspace package's own `dist/index.js` (built by `npm run build:server`).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cliPath = join(repoRoot, 'packages', 'cezar', 'dist', 'index.js');
// The bundled dry-run mock is a shebang-less `.mjs` script. The runner spawns it
// directly, which works on POSIX but fails with `EFTYPE` on win32, where a
// script is not executable. Spawning through a node `.cmd` shim (or `shell:
// true`) fails on win32 too (`EINVAL`), so `execFile` cannot launch it there.
// The `run` test below only works on a platform where the runner's own spawn of
// `scripts/mock-claude.mjs` can execute; the serve test is platform-independent.
const runTestSupported = process.platform !== 'win32';

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`cezar package e2e: the serve fixture never answered at ${url}`);
}

/** The registry as written, or `null` when no config has been written at all. */
async function readProjects(cezHome: string): Promise<Array<{ root: string }> | null> {
  try {
    const workspace = JSON.parse(await readFile(join(cezHome, 'config.json'), 'utf8')) as {
      projects: Array<{ root: string }>;
    };
    return workspace.projects;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Stop a spawned serve and wait for it to actually exit, so a Windows `rm` never races its cwd. */
async function stopServer(server: ChildProcess | null): Promise<void> {
  if (!server) return;
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolveExit) => server.once('exit', () => resolveExit())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }
}

/**
 * Startup-directory invariance (global-workspace task 9, brief step 2): the
 * project registry is driven by EXPLICIT gestures, never by where the process
 * happened to be started.
 *
 * `cezar run --repo <dir>` is repo-scoped: it resolves the repo, runs the
 * headless workflow there, and registers it (the pre-existing package-cli
 * boot-wiring guarantee). `cezar serve` is project-neutral (Task 2): booted
 * with its cwd at an arbitrary folder and an isolated CEZ_HOME, it must NOT
 * append that folder to the registry — serve ignores `--repo`, so the cwd is
 * the only implicit project signal it could act on, and the project-neutral
 * boot acts on none.
 */
test('run --repo registers the explicit repository', { timeout: 120_000, skip: runTestSupported ? false : 'the bundled mock cannot be spawned on win32 (spawn EFTYPE)' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-run-repo-scope-'));
  const cezHome = join(root, 'cez-home');
  const cwd = join(root, 'cwd');
  const fixtureRepo = join(root, 'fixture-repo');
  await mkdir(cwd);
  await mkdir(fixtureRepo);

  try {
    await execFile('git', ['init', '--initial-branch=main'], { cwd: fixtureRepo });
    await writeFile(join(fixtureRepo, 'README.md'), '# E2E fixture\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: fixtureRepo });
    await execFile(
      'git',
      ['-c', 'user.name=Cezar CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'test fixture'],
      { cwd: fixtureRepo },
    );

    const run = await execFile(process.execPath, [cliPath, 'run', 'mock:done', '--repo', fixtureRepo], {
      // The cwd is NOT the repo — `--repo` is the explicit signal, and it is what must register.
      cwd,
      env: { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: cezHome },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.match(run.stdout, /run (done|review)/);

    const projects = await readProjects(cezHome);
    assert.ok(
      projects?.some((project) => project.root === fixtureRepo),
      'a repo-scoped run registers the explicit --repo directory',
    );
    assert.ok(
      !projects?.some((project) => project.root === cwd),
      'a repo-scoped run must not register the process cwd',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serve does not register its launch directory', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-serve-neutrality-'));
  const cezHome = join(root, 'cez-home');
  const cwd = join(root, 'cwd');
  await mkdir(cwd);

  let server: ChildProcess | null = null;
  try {
    const port = await freePort();
    server = spawn(
      process.execPath,
      [cliPath, 'serve', '--port', String(port), '--no-open'],
      {
        cwd,
        env: {
          ...process.env,
          CEZ_DRY_RUN: '1',
          CEZ_HOME: cezHome,
          CEZ_NO_BANNER: '1',
          CEZ_SKILLS_AUTO_UPDATE: '0',
        },
        stdio: 'ignore',
      },
    );
    await waitForHealth(`http://127.0.0.1:${port}`);

    const projects = await readProjects(cezHome);
    assert.ok(
      !projects?.some((project) => project.root === cwd),
      'serve must not register its launch directory',
    );
  } finally {
    await stopServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
