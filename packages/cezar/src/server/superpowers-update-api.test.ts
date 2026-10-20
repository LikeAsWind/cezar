import { describe, expect, it, vi } from 'vitest';
import { createApp } from './server.ts';
import { testRuntime } from './runtime.testkit.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { SuperpowersUpdateState } from '@open-mercato/cezar-contract';
import { SuperpowersUpdateConflictError } from '../superpowers-update.ts';

const state: SuperpowersUpdateState = {
  status: 'idle', current: { version: '7.0.0', commit: 'a'.repeat(40), digest: 'b'.repeat(64) },
  previous: null, latest: null, staged: null, checkedAt: null, autoCheck: false,
};
function setup() {
  const service = {
    snapshot: vi.fn(async () => state), check: vi.fn(async () => state),
    stage: vi.fn(async () => state), activate: vi.fn(async () => state),
    rollback: vi.fn(async () => state), setAutoCheck: vi.fn(async () => state), start: vi.fn(() => () => {}),
  };
  const app = createApp({ runtime: testRuntime(), version: 'test', superpowersUpdate: service });
  return { app, service };
}
describe('workspace Superpowers updates', () => {
  it('reads the snapshot without checking upstream', async () => {
    const { app, service } = setup();
    const response = await apiRequest(app, '/api/v1/workspace/superpowers-update');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(service.check).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
  });
  it('validates review consent and rejects cross-origin mutations', async () => {
    const { app, service } = setup();
    for (const body of [{ digest: 'b'.repeat(64), reviewed: false }, { digest: 'invalid', reviewed: true }]) {
      const response = await apiRequest(app, '/api/v1/workspace/superpowers-update/activate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const response = await apiRequest(app, '/api/v1/workspace/superpowers-update/check', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: '{}',
    });
    expect(response.status).toBe(403);
    expect(service.activate).not.toHaveBeenCalled();
    expect(service.check).not.toHaveBeenCalled();
  });
  it('wires each validated action and reports a lock conflict without leaking details', async () => {
    const { app, service } = setup();
    const actions = [
      ['check', 'POST', {}], ['stage', 'POST', { version: '7.0.1' }],
      ['activate', 'POST', { digest: 'b'.repeat(64), reviewed: true }],
      ['rollback', 'POST', {}], ['settings', 'PUT', { autoCheck: true }],
    ] as const;
    for (const [path, method, body] of actions) {
      const response = await apiRequest(app, `/api/v1/workspace/superpowers-update/${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
    expect(service.check).toHaveBeenCalledWith(true);
    expect(service.stage).toHaveBeenCalledWith('7.0.1');
    expect(service.activate).toHaveBeenCalledWith('b'.repeat(64), true);
    expect(service.setAutoCheck).toHaveBeenCalledWith(true);
    service.check.mockRejectedValueOnce(new SuperpowersUpdateConflictError('private filesystem details'));
    const conflict = await apiRequest(app, '/api/v1/workspace/superpowers-update/check', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain('private filesystem details');
  });
});
