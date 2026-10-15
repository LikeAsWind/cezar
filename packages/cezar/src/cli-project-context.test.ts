import { describe, expect, it } from 'vitest';
import { CliProjectContextError, resolveCliProjectContext } from './cli-project-context.ts';

describe('resolveCliProjectContext', () => {
  it.each([undefined, '', '   '])('requires a project id (%s)', (projectId) => {
    const resolve = () => resolveCliProjectContext({ CEZ_API_URL: 'http://127.0.0.1:4321', CEZ_PROJECT_ID: projectId }, 'cez runs');
    expect(resolve).toThrow(CliProjectContextError);
    expect(resolve).toThrow('cez runs: CEZ_PROJECT_ID is required; run `cezar projects` and select a project id');
  });

  it('normalizes the address and project id and encodes the project path', () => {
    expect(resolveCliProjectContext({ CEZ_API_URL: 'http://127.0.0.1:4321/', CEZ_PROJECT_ID: 'api tools' }, 'cez runs')).toEqual({
      apiUrl: 'http://127.0.0.1:4321',
      projectId: 'api tools',
      apiBase: 'http://127.0.0.1:4321/api/v1/p/api%20tools',
    });
    expect(resolveCliProjectContext({ CEZ_API_URL: 'http://127.0.0.1:4321///', CEZ_PROJECT_ID: ' proj ' }, 'cez task').projectId).toBe('proj');
  });

  it.each([undefined, '', '   '])('requires a cockpit address (%s)', (apiUrl) => {
    const resolve = () => resolveCliProjectContext({ CEZ_API_URL: apiUrl, CEZ_PROJECT_ID: 'proj' }, 'cez automation');
    expect(resolve).toThrow(CliProjectContextError);
    expect(resolve).toThrow('CEZ_API_URL is not set');
  });
});
