export function main(action: string | undefined): Promise<void>;
export function validationPlan(root: string, environment: unknown): Promise<unknown>;
export function captureTree(root: string, runId: string, hostDirectory?: string): Promise<string>;
export function treeDiff(root: string, base: string, head: string): Promise<string>;
export function assertValidationExtension(previous: Record<string, unknown>, next: Record<string, unknown>): void;
export function routeDecision(raw: unknown, previous?: string): { tier: string; reasons: string[]; likelyChangeFileCount: number | null };
