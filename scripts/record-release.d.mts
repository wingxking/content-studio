import type { RuntimeRelease } from '../src/contracts/runtime-release.ts';
export function createReleaseManifest(root: string, version: string, builtAt?: string): Promise<RuntimeRelease>;
