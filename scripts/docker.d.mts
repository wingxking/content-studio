export function copyBackupTrees(sourceRoot: string, destination: string): Promise<void>;
export function writeBackupDestination<T>(destination: string, writer: () => Promise<T>): Promise<T>;
export function youtubeAuthorizationNotice(line: string): { authorizationUrl: string; nextAction: string } | null;
export function prepareDraftBridgeDirectory(bindRoot: string, uid: number, gid: number): Promise<void>;
export function prepareKnowledgeDirectory(bindRoot: string, uid: number, gid: number): Promise<void>;
export function validateKnowledgeSource(value: unknown): Promise<string>;
