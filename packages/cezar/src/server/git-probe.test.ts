import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: fixture.exec,
  }),
}));
import { getRepoInfo } from './git.ts';

beforeEach(() => { fixture.exec.mockReset(); });

it.each(['ENOENT', 'EACCES'])('surfaces %s instead of reporting a non-repository', async code => {
  fixture.exec.mockRejectedValue(Object.assign(new Error(`spawn git ${code}`), { code }));
  await expect(getRepoInfo('/repo', { throwOnError: true })).rejects.toThrow(code);
});

it('keeps the legacy nullable probe for background discovery', async () => {
  fixture.exec.mockRejectedValue(new Error('spawn git ENOENT'));
  expect(await getRepoInfo('/repo')).toBeNull();
});

it('retains the Git diagnostic for a repository rejected by Git', async () => {
  fixture.exec.mockRejectedValue(Object.assign(new Error('Command failed'), {
    code: 128, stderr: 'fatal: detected dubious ownership in repository',
  }));
  await expect(getRepoInfo('/repo', { throwOnError: true })).rejects.toThrow('dubious ownership');
});
