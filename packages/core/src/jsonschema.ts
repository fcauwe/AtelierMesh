// Export a manifest operation to JSON Schema (draft 2020-12), so a server in any language can validate the parameters
// of a step with a standard validator and reach the same verdict as validateParams (designer role).
// Not expressible in JSON Schema, and therefore not exported: the customer role, `visible_if` and `enabled_if`.
import { optionValues } from './manifest'
import type { Manifest, Operation, ParamDef } from './manifest'

export type JsonSchema = Record<string, unknown>

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'

const withRange = (s: JsonSchema, min?: number, max?: number): JsonSchema => ({ ...s, ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}) })

const VEC3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }

export function paramSchema(p: ParamDef): JsonSchema {
  const meta: JsonSchema = {}
  if (p.label !== undefined) meta['title'] = p.label
  if (p.help !== undefined) meta['description'] = p.help
  meta['default'] = p.default
  // presentation hints travel as annotations; a validator ignores them
  if (p.widget !== undefined) meta['x-widget'] = p.widget
  if (p.type === 'enum' && p.shape_style !== undefined) meta['x-shape-style'] = p.shape_style
  if (p.importance !== undefined) meta['x-importance'] = p.importance
  if (p.icon !== undefined) meta['x-icon'] = p.icon
  switch (p.type) {
    case 'bool': return { ...meta, type: 'boolean' }
    case 'int': return withRange({ ...meta, type: 'integer' }, p.min, p.max)
    case 'float':
    case 'angle': return withRange({ ...meta, type: 'number' }, p.min, p.max)
    case 'string': return {
      ...meta, type: 'string',
      ...(p.min_length !== undefined ? { minLength: p.min_length } : {}),
      ...(p.max_length !== undefined ? { maxLength: p.max_length } : {}),
      ...(p.pattern !== undefined ? { pattern: p.pattern } : {}),
    }
    case 'enum': return { ...meta, enum: optionValues(p) }
    case 'vector': return { ...meta, type: 'array', items: withRange({ type: 'number' }, p.min, p.max), minItems: p.size, maxItems: p.size }
    case 'part': {
      const both = !p.kinds || p.kinds.length > 1
      const name = '[^\\u0000-\\u001f]{1,120}'
      const core = both ? `(?:(?:segment|group):)?${name}` : name
      return { ...meta, type: 'string', maxLength: both ? 128 : 120, pattern: p.allow_empty === false ? `^${core}$` : `^(?:${core})?$` }
    }
    case 'range': return { ...meta, type: 'array', items: withRange({ type: 'number' }, p.min, p.max), minItems: 2, maxItems: 2 }
    case 'selection': return {
      ...meta,
      anyOf: [{ type: 'null' }, {
        type: 'object', required: ['mode', 'triangles'], additionalProperties: false,
        properties: { mode: { enum: ['include', 'exclude'] }, basis: { type: 'string' }, triangles: { type: 'array', items: { type: 'array', prefixItems: [{ type: 'integer', minimum: 0 }, { type: 'integer', minimum: 1 }], items: false, minItems: 2, maxItems: 2 } } },
      }],
    }
    case 'list': return {
      ...meta, type: 'array',
      ...(p.min_items !== undefined ? { minItems: p.min_items } : {}), ...(p.max_items !== undefined ? { maxItems: p.max_items } : {}),
      items: { type: 'object', properties: Object.fromEntries(p.item.map(f => [f.name, paramSchema(f)])), additionalProperties: false },
    }
    case 'color': return {
      ...meta, type: 'string',
      // with a palette only, the pattern lists the allowed colours, each letter in both cases (JSON Schema patterns have no ignore-case flag)
      pattern: p.only_palette && p.palette ? `^(?:${p.palette.map(c => c.replace(/[a-f]/gi, ch => `[${ch.toLowerCase()}${ch.toUpperCase()}]`)).join('|')})$` : p.alpha ? '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$' : '^#[0-9a-fA-F]{6}$',
    }
    case 'object': return { ...meta, type: 'object', properties: Object.fromEntries(p.fields.map(f => [f.name, paramSchema(f)])), additionalProperties: false }
    case 'asset': return { ...meta, anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] }
    case 'payload': return { ...meta, anyOf: [{ type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' }, { type: 'null' }] }
    case 'placement': return {
      ...meta,
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['anchor'],
          properties: {
            anchor: {
              type: 'object',
              required: ['point', 'normal'],
              properties: {
                point: VEC3, normal: VEC3, tri: { type: 'integer', minimum: 0 }, bary: VEC3, fingerprint: { type: 'string' },
              },
            },
            up_ref: { enum: ['x', 'y', 'z'] },
            direction: { type: 'number', minimum: -180, maximum: 180 },
            offset: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            align: { type: 'object', required: ['h', 'v'], properties: { h: { enum: ['left', 'center', 'right'] }, v: { enum: ['baseline', 'middle'] } } },
          },
        },
      ],
    }
  }
}

/** The parameters object of one operation. Unknown parameters are rejected; missing ones are allowed (defaults apply). */
export function operationParamsSchema(plugin: { id: string; version: string }, op: Operation): JsonSchema {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: `urn:ateliermesh:${plugin.id}:${plugin.version}:${op.id}:params`,
    title: op.title ?? op.id,
    type: 'object',
    properties: Object.fromEntries(op.params.map(p => [p.name, paramSchema(p)])),
    additionalProperties: false,
  }
}

/** One schema per operation, keyed by operation id. */
export function manifestSchemas(m: Manifest): Record<string, JsonSchema> {
  return Object.fromEntries(m.operations.map(op => [op.id, operationParamsSchema(m, op)]))
}

/**
 * A JSON Schema for the top of a manifest file: the identity fields and the metadata every plugin carries (`license`, `description`) and may carry
 * (`contact`, `package_url`). The operations are described one by one by `operationParamsSchema`; here they are only required to be a list of objects.
 * `requireMetadata` (default true, as for external packages and built-in plugins) makes `license` and `description` required.
 */
export function manifestDocumentSchema(opts: { requireMetadata?: boolean } = {}): JsonSchema {
  const require = opts.requireMetadata !== false
  const https = (max: number): JsonSchema => ({ type: 'string', format: 'uri', pattern: '^https://[^\\s@/]+(/[^\\s]*)?$', maxLength: max })
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'AtelierMesh plugin manifest',
    type: 'object',
    required: ['manifest_version', 'id', 'name', 'version', 'operations', ...(require ? ['license', 'description'] : [])],
    properties: {
      manifest_version: { const: 1 },
      id: { type: 'string' },
      name: { type: 'string', minLength: 1 },
      version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$' },
      description: { type: 'string', minLength: 10, maxLength: 300, pattern: '^[^\\u0000-\\u001f\\u007f]*$', description: 'What the plugin does, in plain text.' },
      author: { type: 'string' },
      license: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9.+\\- ]+$', description: 'An SPDX identifier, or Proprietary.' },
      contact: { type: 'object', additionalProperties: false, properties: { url: https(200), email: { type: 'string', maxLength: 120, pattern: '^[^\\s@<>"\'()\\[\\],;:\\\\]{1,64}@[A-Za-z0-9.-]+\\.[A-Za-z0-9-]+$' }, name: { type: 'string', minLength: 1, maxLength: 80 } } },
      package_url: { ...https(300), description: 'Where the packed .amplugin can be fetched again (https only).' },
      image: { type: 'object', additionalProperties: false, required: ['file', 'alt'], properties: { file: { type: 'string', pattern: '^[A-Za-z0-9_./-]{1,100}$', not: { pattern: '(^|/)\\.{0,2}(/|$)' } }, alt: { type: 'string', minLength: 5, maxLength: 160 } }, description: 'Example picture for the plugin gallery (PNG, JPEG or WebP, up to 300 KB).' },
      permissions: { type: 'array', maxItems: 20, items: { type: 'string' } },
      uses: { type: 'array', maxItems: 4, items: { enum: ['fonts'] }, description: 'Host services the plugin calls: fonts = ctx.fonts.outline(...).' },
      operations: { type: 'array', minItems: 1, items: { type: 'object' } },
    },
  }
}
