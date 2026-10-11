import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { codexOutputSchema, parseStructuredOutput } from '../src/core/structured-output.ts';

type Tree = { id: string; note?: string; marker?: string | null; children?: Tree[] };
const tree: z.ZodType<Tree> = z.lazy(() => z.object({ id: z.string(), note: z.string().optional(), marker: z.string().nullable().optional(), children: z.array(tree).optional() }));
test('nullable wire normalization preserves genuine nulls, arrays, references and required validation', () => {
  const schema = z.object({ content: tree.nullable() });
  const wire = codexOutputSchema(schema);
  const assertRequired = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(assertRequired); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (item.properties && typeof item.properties === 'object') assert.deepEqual(item.required, Object.keys(item.properties));
    Object.values(item).forEach(assertRequired);
  };
  assertRequired(wire);
  assert.deepEqual(parseStructuredOutput(schema, { content: null }), { content: null });
  assert.deepEqual(parseStructuredOutput(schema, { content: { id: 'root', note: null, marker: null, children: [{ id: 'child', note: null, marker: null, children: null }] } }), { content: { id: 'root', marker: null, children: [{ id: 'child', marker: null }] } });
  assert.throws(() => parseStructuredOutput(schema, { content: { id: null, note: null, children: null } }));
});
