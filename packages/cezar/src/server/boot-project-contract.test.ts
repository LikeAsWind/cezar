import { describe, expect, it } from 'vitest';
import { healthResponseSchema, projectListEntrySchema } from '@open-mercato/cezar-contract';

describe('project-neutral workspace contracts', () => {
  it('does not declare a boot project on health', () => {
    expect(healthResponseSchema.shape).not.toHaveProperty('bootProject');
  });

  it('does not declare synthetic unregistered project rows', () => {
    expect(projectListEntrySchema.shape).not.toHaveProperty('unregistered');
  });
});
