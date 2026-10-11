import { z } from 'zod';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function resolveReference(schema: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return schema;
  let value: unknown = root;
  for (const key of schema.$ref.slice(2).split('/')) {
    value = record(value) ? value[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  return record(value) ? value : schema;
}
function allowsNull(schema: unknown, root: Record<string, unknown>): boolean {
  if (!record(schema)) return false;
  const definition = resolveReference(schema, root);
  return definition.type === 'null' || Array.isArray(definition.type) && definition.type.includes('null')
    || Array.isArray(definition.anyOf) && definition.anyOf.some(branch => allowsNull(branch, root));
}

export function codexOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const root = z.record(z.string(), z.unknown()).parse(z.toJSONSchema(schema));
  const formats = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!record(value)) return value;
    const result: Record<string, unknown> = Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => key !== '$schema' && !(key === 'format' && typeof item === 'string' && !formats.has(item)))
      .map(([key, item]) => [key, visit(item)]));
    if (record(value.properties) && record(result.properties)) {
      const properties = value.properties;
      const required = new Set(Array.isArray(value.required) ? value.required : []);
      result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, property]) => [key,
        required.has(key) || allowsNull(properties[key], root) ? property : { anyOf: [property, { type: 'null' }] },
      ]));
      result.required = Object.keys(value.properties);
    }
    return result;
  };
  // Optional domain fields become required nullable wire fields. URI validation stays local.
  return z.record(z.string(), z.unknown()).parse(visit(root));
}

export function parseStructuredOutput<T>(schema: z.ZodType<T>, value: unknown): T {
  const root = z.record(z.string(), z.unknown()).parse(z.toJSONSchema(schema));
  const matches = (definition: unknown, input: unknown): boolean => {
    if (!record(definition)) return false;
    const spec = resolveReference(definition, root);
    if (Array.isArray(spec.anyOf)) return spec.anyOf.some(branch => matches(branch, input));
    if (spec.type === 'object') return record(input) && (!record(spec.properties) || Object.entries(spec.properties).every(([key, property]) => !record(property) || property.const === undefined || input[key] === property.const));
    if (spec.type === 'array') return Array.isArray(input);
    if (spec.type === 'null') return input === null;
    return spec.type === typeof input || spec.type === 'integer' && typeof input === 'number';
  };
  const normalize = (definition: unknown, input: unknown): unknown => {
    if (!record(definition)) return input;
    const spec = resolveReference(definition, root);
    if (Array.isArray(spec.anyOf)) return normalize(spec.anyOf.find(branch => matches(branch, input)), input);
    if (Array.isArray(input) && spec.type === 'array') return input.map(item => normalize(spec.items, item));
    if (!record(input) || !record(spec.properties)) return input;
    const properties = spec.properties;
    const required = new Set(Array.isArray(spec.required) ? spec.required : []);
    return Object.fromEntries(Object.entries(input).flatMap(([key, item]) =>
      item === null && properties[key] !== undefined && !required.has(key) && !allowsNull(properties[key], root)
        ? [] : [[key, normalize(properties[key], item)]]));
  };
  // Preserve genuinely nullable fields; remove only optional wire nulls, then enforce domain validation.
  return schema.parse(normalize(root, value));
}
