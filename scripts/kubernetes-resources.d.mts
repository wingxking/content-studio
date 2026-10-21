export const applicationNames: string[];
export type KubernetesSettings = { namespace: string; node: string; nodeRoot: string; uid: number; gid: number; images: { application: string; model: string; renderer: string; tts: string; knowledge?: string }; publicOrigin: string; supabaseUrl: string; bridgePort?: number; exposePublic?: boolean; ttsFingerprint?: string; workspaceId?: string };
export function kubernetesResources(settings: KubernetesSettings): unknown[];
