/** Restore public web-client constants from the supplied binary into ignored local configuration. */
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const input = process.argv[2];
if (!input)
  throw new Error(
    "Usage: npm run restore:client-config -- /path/to/wechatsync-2.0.9.zip",
  );
const bytes = readFileSync(input);
const recovery = JSON.parse(
  readFileSync(new URL("../recovery.json", import.meta.url), "utf8"),
);
if (createHash("sha256").update(bytes).digest("hex") !== recovery.sha256)
  throw new Error("Input ZIP does not match the reviewed 2.0.9 archive.");
const archive = await JSZip.loadAsync(bytes);
const entry = archive.file("assets/index.ts-Bw-475TG.js");
if (!entry) throw new Error("Background bundle is missing.");
const source = await entry.async("string");
const patterns = {
  VITE_CSDN_WEB_CLIENT_ID: /g\(this,"API_KEY","([^"]+)"\)/,
  VITE_CSDN_WEB_CLIENT_SECRET: /g\(this,"API_SECRET","([^"]+)"\)/,
  VITE_X_WEB_BEARER: /ks="([^"]+)"/,
};
const lines = Object.entries(patterns).map(([name, pattern]) => {
  const value = source.match(pattern)?.[1];
  if (!value) throw new Error(`Missing client setting: ${name}`);
  return `${name}=${JSON.stringify(value)}`;
});
const output = fileURLToPath(new URL("../.env.local", import.meta.url));
writeFileSync(output, lines.join("\n") + "\n", { mode: 0o600 });
chmodSync(output, 0o600);
console.log(
  "Restored three web-client settings to ignored .env.local; values were not logged.",
);
