import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, extname, relative, resolve } from 'node:path';
import test from 'node:test';

// Transitional pure schemas are the only value imports allowed across the browser/core boundary.
const pureCore = new Set(['model.ts', 'task-model.ts', 'article-document.ts', 'knowledge-model.ts', 'finance-platforms.ts', 'execution-contract.ts']);
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/u, '')));
const root = resolve(import.meta.dirname, '..');
function valueImports(source: string, filename: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, ''); const imports: string[] = [];
  const declarations = /\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of code.matchAll(declarations)) {
    const [, onlyType, clause = '', specifier] = match;
    const named = clause.trim();
    const onlyNamedTypes = named.startsWith('{') && named.endsWith('}') && named.slice(1, -1).split(',').every(item => !item.trim() || /^type\s/u.test(item.trim()));
    if (!onlyType && !onlyNamedTypes && specifier) imports.push(specifier);
  }
  for (const match of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) if (match[1]) imports.push(match[1]);
  for (const match of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/gu)) if (match[1]) imports.push(match[1]);
  assert.doesNotMatch(code, /\bprocess\s*\./u, `Node process API in ${filename}`);
  assert.doesNotMatch(code, /\brequire\s*\(/u, `Node require in ${filename}`);
  return imports;
}
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(resolve(directory, entry.name)) : /\.tsx?$/u.test(entry.name) ? [resolve(directory, entry.name)] : []))).flat();
}

test('browser value graph cannot reach execution, persistence, or Node builtins', async () => {
  const pending = (await Promise.all(['src/ui', 'src/client', 'src/contracts'].map(directory => sourceFiles(resolve(root, directory))))).flat(); const seen = new Set<string>();
  while (pending.length) {
    const filename = pending.pop(); assert.ok(filename); if (seen.has(filename)) continue; seen.add(filename);
    for (const specifier of valueImports(await readFile(filename, 'utf8'), relative(root, filename))) {
      assert.equal(specifier.startsWith('node:') || builtins.has(specifier), false, `${relative(root, filename)} imports ${specifier}`);
      if (!specifier.startsWith('.')) continue;
      const dependency = resolve(dirname(filename), specifier); const path = relative(root, dependency).replaceAll('\\', '/');
      assert.match(path, /^src\/(ui|client|contracts|core)\//u, `Forbidden browser dependency ${path}`);
      if (path.startsWith('src/core/')) assert.ok(pureCore.has(path.slice('src/core/'.length)), `Non-contract core value dependency ${path}`);
      if (/^\.tsx?$/u.test(extname(dependency))) pending.push(dependency);
    }
  }
  assert.ok(seen.size >= 20);
});

test('boundary scanner distinguishes type-only references and catches lazy value imports', () => {
  assert.deepEqual(valueImports("import type { A } from '../core/store.ts'; import { type B } from '../core/video.ts'; import { z } from 'zod'; const view = import('./view.tsx');", 'fixture.tsx'), ['zod', './view.tsx']);
  assert.throws(() => valueImports('const token = process.env.TOKEN;', 'fixture.tsx'), /Node process API/);
});
