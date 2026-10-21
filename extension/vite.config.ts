import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, transformWithEsbuild, type Plugin } from "vite";
import manifest from "./manifest.json";

const root = fileURLToPath(new URL(".", import.meta.url));

function recoveredStaticAssets(): Plugin {
  return {
    name: "recovered-static-assets",
    buildStart() {
      this.addWatchFile(resolve(root, "src/injected/api.ts"));
      for (const name of ["reader.js", "Readability.js"]) {
        this.addWatchFile(resolve(root, "public/lib", name));
      }
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "LICENSE",
        source: readFileSync(resolve(root, "LICENSE")),
      });
      for (const name of ["reader.js", "Readability.js"]) {
        this.emitFile({
          type: "asset",
          fileName: name,
          source: readFileSync(resolve(root, "public/lib", name)),
        });
      }
      const source = readFileSync(resolve(root, "src/injected/api.ts"), "utf8");
      const result = await transformWithEsbuild(source, "inject-api.ts", {
        loader: "ts",
        format: "iife",
        target: "es2022",
      });
      this.emitFile({
        type: "asset",
        fileName: "inject-api.js",
        source: result.code,
      });
    },
    writeBundle() {
      const manifestPath = resolve(root, "dist/manifest.json");
      const built = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        content_scripts: unknown[];
      };
      built.content_scripts.unshift(readerScript);
      writeFileSync(manifestPath, JSON.stringify(built, null, 2) + "\n");
    },
  };
}

const readerScript = {
  js: ["reader.js", "Readability.js"],
  matches: ["http://*/*", "https://*/*"],
  run_at: "document_start" as const,
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "VITE_");
  return {
    plugins: [react(), crx({ manifest }), recoveredStaticAssets()],
    resolve: {
      alias: {
        "@": resolve(root, "src"),
        "@wechatsync/core": resolve(root, "core/src"),
      },
    },
    define: {
      "import.meta.env.PROD": JSON.stringify(mode !== "development"),
      "import.meta.env.DEV": JSON.stringify(mode === "development"),
      "import.meta.env.VITE_CSDN_WEB_CLIENT_ID": JSON.stringify(
        env.VITE_CSDN_WEB_CLIENT_ID || "",
      ),
      "import.meta.env.VITE_CSDN_WEB_CLIENT_SECRET": JSON.stringify(
        env.VITE_CSDN_WEB_CLIENT_SECRET || "",
      ),
      "import.meta.env.VITE_X_WEB_BEARER": JSON.stringify(
        env.VITE_X_WEB_BEARER || "",
      ),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: true,
      minify: mode === "development" ? false : "esbuild",
      rollupOptions: {
        input: {
          popup: resolve(root, "src/popup/index.html"),
          editor: resolve(root, "src/editor/index.html"),
          "sync-dialog": resolve(root, "src/sync-dialog/index.html"),
          preprocessor: resolve(root, "src/preprocessor/index.html"),
        },
      },
    },
  };
});
