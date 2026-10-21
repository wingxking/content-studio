import {
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "dist");
const version = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")).version;
const zip = new JSZip();
function add(directory) {
  for (const name of readdirSync(directory).sort()) {
    const file = resolve(directory, name);
    if (statSync(file).isDirectory()) add(file);
    else
      zip.file(relative(dist, file).split("\\").join("/"), readFileSync(file));
  }
}
add(dist);
mkdirSync(resolve(root, "artifacts"), { recursive: true });
const output = resolve(root, `artifacts/content-studio-extension-${version}.zip`);
writeFileSync(
  output,
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
console.log(`Created ${relative(root, output)}`);

// Ship the corresponding modified source alongside the binary distribution.
const sources = new JSZip();
function addSource(directory) {
  for (const name of readdirSync(directory).sort()) {
    if (['node_modules', 'dist', 'artifacts', '.git', '.recovery'].includes(name) || name.startsWith('.env')) continue;
    const file = resolve(directory, name);
    if (statSync(file).isDirectory()) addSource(file);
    else sources.file('extension/' + relative(root, file).split('\\').join('/'), readFileSync(file));
  }
}
for (const directory of ['src', 'core', 'public', 'assets', 'scripts', 'tests']) addSource(resolve(root, directory));
for (const name of readdirSync(root).filter(name => /^(?:package(?:-lock)?\.json|manifest\.json|tsconfig.*\.json|vite.*\.ts|vitest.*\.ts|postcss\.config\.js|tailwind\.config\.[jt]s|Dockerfile.*|LICENSE|README\.md|RESTORATION\.md|recovery\.json|\.env\.example)$/.test(name))) sources.file('extension/' + name, readFileSync(resolve(root, name)));
for (const name of ['studio-ui.ts','studio-tokens.css']) sources.file('src/contracts/'+name,readFileSync(resolve(root,'..','src','contracts',name)));
sources.file('BUILD.md','Run npm ci and npm run build inside extension/. The adjacent src/contracts directory contains the shared original UI contract and design tokens. See extension/LICENSE and extension/RESTORATION.md.');
const sourceOutput = resolve(root, `artifacts/content-studio-extension-source-${version}.zip`);
writeFileSync(sourceOutput, await sources.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Created ${relative(root, sourceOutput)}`);
