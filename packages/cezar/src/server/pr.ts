/**
 * Thin delegate — draft-PR creation (review gate, spec 009) moved behind the
 * forge-driver seam (`src/server/forge/github.ts`, cockpit-ui redesign spec
 * §"Forge-driver seam"). Kept so existing imports keep working.
 */
export { buildPrBody } from './forge/github.ts';
export { createForgePr as createDraftPr } from './forge/operations.ts';
export type { DraftPrInput, DraftPrOutcome } from './forge/types.ts';
