import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("restored source boundaries", () => {
  it("keeps application TypeScript checked instead of hiding untyped bundle code", () => {
    const problems: string[] = [];
    for (const file of [
      ...files(resolve(root, "src")),
      ...files(resolve(root, "core/src")),
    ].filter((name) => /\.tsx?$/.test(name))) {
      const text = readFileSync(file, "utf8");
      if (/@ts-(?:ignore|nocheck)/.test(text))
        problems.push(`${file}: disabled type checking`);
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      function inspect(node: ts.Node) {
        if (node.kind === ts.SyntaxKind.AnyKeyword)
          problems.push(`${file}: explicit unchecked type`);
        ts.forEachChild(node, inspect);
      }
      inspect(source);
    }
    expect(problems).toEqual([]);
    const config = JSON.parse(
      readFileSync(resolve(root, "tsconfig.json"), "utf8"),
    );
    expect(config.compilerOptions.strict).toBe(true);
  });

  it("keeps all source entrypoints and the original MV3 permission surface explicit", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "manifest.json"), "utf8"),
    );
    expect(manifest.version).toBe("2.0.13");
    expect(manifest.host_permissions).toEqual(["http://*/*", "https://*/*"]);
    expect(
      manifest.content_scripts.flatMap((script: { js: string[] }) => script.js),
    ).toEqual([
      "src/content/weixin.ts",
      "src/content/weixin-editor.ts",
      "src/content/toutiao.ts",
      "src/content/extractor.ts",
    ]);
    expect(manifest.content_scripts.flatMap((script: { js: string[] }) => script.js)).not.toContain("src/content/api.ts");
    expect(manifest.web_accessible_resources.flatMap((entry: { resources: string[] }) => entry.resources)).not.toContain("inject-api.js");
    for (const entry of [
      manifest.background.service_worker,
      ...manifest.content_scripts.flatMap(
        (script: { js: string[] }) => script.js,
      ),
      "src/injected/api.ts",
    ]) {
      expect(readFileSync(resolve(root, entry), "utf8").length).toBeGreaterThan(
        100,
      );
    }
  });

  it("does not depend on a private submodule or a precompiled recovery payload", () => {
    const source = readFileSync(resolve(root, "src/adapters/index.ts"), "utf8");
    expect(source).not.toContain("import.meta.glob");
    for (const file of files(resolve(root, "src")).filter((name) =>
      /\.tsx?$/.test(name),
    )) {
      expect(readFileSync(file, "utf8")).not.toMatch(
        /(?:from\s*|import\s*\()["'][^"']*(?:\.recovery|\.zip|private\/)/,
      );
    }
  });
});
