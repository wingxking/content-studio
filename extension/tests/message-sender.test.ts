import { describe, expect, it } from "vitest";
import { isBridgeSettingsSender } from "../src/studio/message-sender";

const id = "ocmaklkebfcdiamgpklonpcbcffcnjmp";
describe("bridge management sender", () => {
  it("permits extension settings both as popup and tab", () => {
    expect(isBridgeSettingsSender({ id, url: `chrome-extension://${id}/src/popup/index.html#/about` }, id)).toBe(true);
  });
  it("rejects page scripts even when Chrome assigns the extension id", () => {
    for (const url of ["https://example.com/src/popup/index.html", `https://${id}/src/popup/index.html`, `chrome-extension://${id}/src/editor/index.html`, "not a URL"]) {
      expect(isBridgeSettingsSender({ id, url }, id)).toBe(false);
    }
    expect(isBridgeSettingsSender({ id: "another", url: `chrome-extension://${id}/src/popup/index.html` }, id)).toBe(false);
    expect(isBridgeSettingsSender(undefined, id)).toBe(false);
  });
});
