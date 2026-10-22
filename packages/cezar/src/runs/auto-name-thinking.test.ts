import { afterEach, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn(async () => ({ text: '{"title":"fixing buffer double return"}' })));
vi.mock('../core/runner-factory.ts', () => ({ createRunner: () => ({ run }) }));
vi.mock('../config.ts', () => ({ loadConfig: async () => ({ defaultRunner: 'claude', namerModel: 'haiku' }) }));
vi.mock('../workspace/agent-profiles.ts', () => ({ resolveProfileEnvForRoot: async () => ({ env: { MAX_THINKING_TOKENS: '4096', PROFILE_SENTINEL: 'preserved' } }) }));
import { generateRunName } from './auto-name.ts';
afterEach(() => vi.clearAllMocks());
it('disables thinking only for naming while preserving the selected profile environment', async () => {
 const result = await generateRunName('project', { task: 'Fix buffer double return' });
 expect(result?.titleSummary).toBe('fixing buffer double return');
 expect(run).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku', env: expect.objectContaining({ MAX_THINKING_TOKENS: '0', PROFILE_SENTINEL: 'preserved' }) }));
});
