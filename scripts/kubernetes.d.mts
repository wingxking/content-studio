export function validateNamespace(value: string): string;
export function parsePrivateEnvironment(content: string): Record<string, unknown>;
export function settingsFingerprint(settings: unknown): string;
export function validateCutoverEvidence(settings: Record<string, unknown>, preflight: Record<string, unknown>, evidence: Record<string, unknown>, at?: number, backupDirectory?: string): void;
export function adoptedRuntime(settings: { mountRoot: string; namespace: string; context: string; workspaceId: string }): Promise<import('./docker.mjs').RuntimeOrchestrator>;
