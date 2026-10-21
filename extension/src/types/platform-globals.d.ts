interface Window {
  XPForwardedForSDK?: {
    getForwardedForStr(): Promise<{ str: string; expiryTimeMillis: string }>;
  };
  neg?: { getToken(): Promise<{ code: number; token?: string }> };
  _webmsxyw?: (path: string) => Record<string, string>;
}
