/** Allow the same settings UI in a popup or a full tab, never page scripts. */
export function isBridgeSettingsSender(
  sender: Pick<chrome.runtime.MessageSender, "id" | "url"> | undefined,
  extensionId: string,
): boolean {
  if (sender?.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" && url.hostname === extensionId && url.pathname === "/src/popup/index.html";
  } catch {
    return false;
  }
}
