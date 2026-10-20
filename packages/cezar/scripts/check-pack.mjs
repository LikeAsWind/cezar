#!/usr/bin/env node
// Tarball bundle check (`npm run check:pack`, last leg of `npm run build`):
// fail loudly when the published package would ship without the built UI —
// phase R1 of the cockpit redesign once published a tarball with no cockpit
// in it, and this pins that bug class before every publish (prepublishOnly →
// build → check:pack).
//
// Asks npm itself what it would pack (`npm pack --dry-run --json`) and hands
// the file list to the pure, unit-tested decision in src/pack-check.ts.
// Imports from dist/, so it must run AFTER `tsc` — `npm run build` orders
// tsc → build:web → check:pack, which also guarantees web/dist exists in a
// fresh checkout by the time the check looks for it.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { findPackGaps } from '../dist/pack-check.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Under `npm run`, npm_execpath is npm's own cli.js — running it through
// process.execPath works on every platform (no .cmd shim needed on Windows).
const npmExecpath = process.env.npm_execpath;
const packArgs = ['pack', '--dry-run', '--json'];
const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const stdout = npmExecpath
  ? execFileSync(process.execPath, [npmExecpath, ...packArgs], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  : execFileSync(npmCli, packArgs, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });

/** @type {{ files?: { path: string }[] }[]} */
const reports = JSON.parse(stdout);
const files = (reports[0]?.files ?? []).map((f) => f.path);
if (files.length === 0) {
  console.error('check:pack: `npm pack --dry-run --json` reported no files — refusing to publish an empty package');
  process.exit(1);
}

const gaps = findPackGaps(files);
if (!files.includes('scripts/probe-policy.mjs')) gaps.push('host probe policy script missing: scripts/probe-policy.mjs');
for (const entry of ['scripts/workflow-action.mjs', 'scripts/workflow/artifacts.mjs', 'dist/workflows/templates/unattended.js', 'dist/workflows/superpowers-bundle.js']) {
  if (!files.includes(entry)) gaps.push(`host workflow action asset missing: ${entry}`);
}
const unattended = 'dist/workflows/assets/superpowers';
const manifest = JSON.parse(readFileSync(path.join(repoRoot, unattended, 'provenance.json'), 'utf8'));
const required = ['skills/project-probe/SKILL.md', 'skills/adjudicator/SKILL.md', 'context.md', 'provenance.json',
  ...Object.keys(manifest.files)];
for (const entry of required) {
  if (!files.includes(`${unattended}/${entry}`)) gaps.push(`built-in unattended asset missing: ${unattended}/${entry}`);
}
if (gaps.length > 0) {
  console.error('check:pack: the npm tarball would ship a broken cockpit:');
  for (const gap of gaps) console.error(`  - ${gap}`);
  process.exit(1);
}

const uiFiles = files.filter((f) => f.startsWith('web/dist/')).length;
console.log(`check:pack ok — ${files.length} files, ${uiFiles} under web/dist (shell + assets present)`);
