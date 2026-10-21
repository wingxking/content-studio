/**
 * DOM 预处理页面
 *
 * 当没有可用的 http/https tab 时，Service Worker 创建此页面的临时 tab 做 DOM 预处理。
 * 处理完后 tab 自动关闭。
 */
import { htmlToMarkdownNative, type PreprocessConfig } from "@wechatsync/core";
import {
  preprocessContentDOM,
  preprocessForPlatform,
  type PreprocessResult,
} from "../lib/content-processor";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "STUDIO_PREPROCESS_DOCUMENT" || sender.id !== chrome.runtime.id || sender.tab) return false;
  void chrome.tabs.getCurrent().then(tab => {
    if (tab?.id !== message.targetTabId) return;
    try {
    const { rawHtml, platforms, configs } = message.payload as {
      rawHtml: string;
      platforms: string[];
      configs: Record<string, PreprocessConfig>;
    };

    const platformContents: Record<string, PreprocessResult> = {};

    for (const platformId of platforms) {
      const config = configs[platformId];
      if (config) {
        platformContents[platformId] = preprocessForPlatform(rawHtml, config);
      } else {
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = rawHtml;
        preprocessContentDOM(tempDiv);
        const html = tempDiv.innerHTML;
        platformContents[platformId] = {
          html,
          markdown: htmlToMarkdownNative(html),
        };
      }
    }

    sendResponse({ platformContents });
    } catch { sendResponse({ error: "Document preprocessing failed" }); }
  }).catch(() => sendResponse({ error: "Preprocessor document unavailable" }));
  return true;
});
