import { expect, it } from 'vitest';
import { buildPrBody } from './github.ts';

const handoff = '## Goal\nFix duplicate buffer returns\n\n## Progress log\n- step "seal" complete\n';
const summary = '## 解决方案\nMake close idempotent and return buffers to their owner.\n\n## 测试\n298 tests, no failures.\n\n## 遗留限制\nProduction trigger not reproduced.';

it('uses the completed delivery report instead of workflow progress in the PR body', () => {
  const body = buildPrBody(handoff, 'fallback', { summary, verdict: 'ready' });
  expect(body).toContain('Fix duplicate buffer returns');
  expect(body).toContain(summary);
  expect(body).not.toContain('Progress log');
  expect(body).not.toContain('seal');
});

it('keeps the handoff fallback for workflows without a completed delivery report', () => {
  for (const delivery of [undefined, { summary, verdict: 'blocked' }, { summary: ' ', verdict: 'ready' }]) {
    expect(buildPrBody(handoff, 'fallback', delivery)).toContain('step "seal" complete');
  }
});
