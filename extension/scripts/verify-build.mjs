import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "dist");
const manifest = JSON.parse(
  readFileSync(resolve(dist, "manifest.json"), "utf8"),
);
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")).version);
assert.equal(manifest.version_name, manifest.version);
assert.equal(manifest.version, JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version);
assert.equal(manifest.content_scripts.length, 5);
assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);

function checkAsset(name) {
  assert(
    !name.includes("..") && !name.startsWith("/"),
    `Invalid asset path: ${name}`,
  );
  assert(existsSync(resolve(dist, name)), `Missing extension asset: ${name}`);
}
checkAsset(manifest.background.service_worker);
checkAsset(manifest.action.default_popup);
Object.values(manifest.icons).forEach(checkAsset);
manifest.content_scripts
  .flatMap((script) => script.js ?? [])
  .forEach(checkAsset);
for (const name of [
  "inject-api.js",
  "reader.js",
  "Readability.js",
  "src/editor/index.html",
  "src/sync-dialog/index.html",
  "src/preprocessor/index.html",
])
  checkAsset(name);
for (const entry of manifest.web_accessible_resources) {
  for (const name of entry.resources) if (!name.includes("*")) checkAsset(name);
}

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const emitted = files(dist);
for (const file of emitted.filter((name) => name.endsWith(".js"))) {
  const code = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(
    source.parseDiagnostics.length,
    0,
    `Invalid emitted JavaScript: ${file}`,
  );
  function inspect(node) {
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    )
      specifier = node.moduleSpecifier;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      specifier = node.arguments[0];
    if (
      specifier &&
      ts.isStringLiteral(specifier) &&
      specifier.text.startsWith(".")
    ) {
      assert(
        existsSync(resolve(dirname(file), specifier.text)),
        `Unresolved emitted import: ${specifier.text}`,
      );
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}
const maps = emitted
  .filter((name) => name.endsWith(".map"))
  .map((name) => JSON.parse(readFileSync(name, "utf8")));
const sources = maps.flatMap((map) => map.sources);
const recovery = JSON.parse(
  readFileSync(resolve(root, "recovery.json"), "utf8"),
);
for (const adapter of recovery.privateAdapters) {
  assert(
    sources.some((name) => name.endsWith(`/recovered/${adapter}.ts`)),
    `Missing recovered adapter in build: ${adapter}`,
  );
}
console.log(
  `Verified MV3 assets, JavaScript imports, four pages and ${recovery.privateAdapters.length} recovered adapter sources.`,
);
