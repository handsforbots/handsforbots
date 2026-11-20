const MAX_DEPTH = 32
const MAX_PROPERTIES = 64
const MAX_ENUM = 1024
const MAX_ARRAY_ITEMS = 256

export class JsonSchemaValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'JsonSchemaValidationError'
  }
}

type JsonSchema = Record<string, unknown>

export function validateJsonSchema(schema: unknown, value: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new JsonSchemaValidationError('', 'parameters schema must be an object')
  }
  validateValue(value, schema as JsonSchema, '', 0, new WeakSet())
  return value
}

function validateValue(value: unknown, schema: JsonSchema, path: string, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_DEPTH) throw new JsonSchemaValidationError(path, 'maximum schema depth exceeded')
  if ('const' in schema) {
    if (!sameJson(value, schema.const)) throw new JsonSchemaValidationError(path, 'must match const')
    return
  }
  if ('enum' in schema) {
    const list = schema.enum
    if (!Array.isArray(list) || list.length > MAX_ENUM) {
      throw new JsonSchemaValidationError(path, 'invalid enum in schema')
    }
    if (!list.some((v) => sameJson(value, v))) throw new JsonSchemaValidationError(path, 'must be one of the allowed values')
    return
  }

  const types = typeNames(schema.type)
  if (types.length > 0) {
    const match = types.some((t) => valueMatchesType(value, t))
    if (!match) throw new JsonSchemaValidationError(path, `must be ${types.join(' or ')}`)
  }

  if (value === null) return

  if (typeof value === 'string') {
    const minLength = numberKeyword(schema, 'minLength')
    const maxLength = numberKeyword(schema, 'maxLength')
    if (minLength !== undefined && value.length < minLength) {
      throw new JsonSchemaValidationError(path, `must be at least ${minLength} characters`)
    }
    if (maxLength !== undefined && value.length > maxLength) {
      throw new JsonSchemaValidationError(path, `must be at most ${maxLength} characters`)
    }
    return
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JsonSchemaValidationError(path, 'must be a finite number')
    if (schema.type === 'integer' && !Number.isInteger(value)) {
      throw new JsonSchemaValidationError(path, 'must be an integer')
    }
    for (const bound of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
      const limit = numberKeyword(schema, bound)
      if (limit === undefined) continue
      if (bound === 'minimum' && value < limit) throw new JsonSchemaValidationError(path, `must be >= ${limit}`)
      if (bound === 'maximum' && value > limit) throw new JsonSchemaValidationError(path, `must be <= ${limit}`)
      if (bound === 'exclusiveMinimum' && value <= limit) throw new JsonSchemaValidationError(path, `must be > ${limit}`)
      if (bound === 'exclusiveMaximum' && value >= limit) throw new JsonSchemaValidationError(path, `must be < ${limit}`)
    }
    return
  }

  if (typeof value === 'boolean') return

  if (Array.isArray(value)) {
    const minItems = numberKeyword(schema, 'minItems')
    const maxItems = numberKeyword(schema, 'maxItems')
    if (minItems !== undefined && value.length < minItems) {
      throw new JsonSchemaValidationError(path, `must have at least ${minItems} items`)
    }
    const cap = maxItems ?? MAX_ARRAY_ITEMS
    if (value.length > cap) throw new JsonSchemaValidationError(path, `must have at most ${cap} items`)
    const itemSchema = schema.items
    if (itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema)) {
      for (let i = 0; i < value.length; i++) {
        validateValue(value[i], itemSchema as JsonSchema, itemPath(path, String(i)), depth + 1, seen)
      }
    }
    return
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new JsonSchemaValidationError(path, 'circular structure')
    seen.add(value)
    const record = value as Record<string, unknown>
    const properties = schema.properties
    const propMap = properties && typeof properties === 'object' && !Array.isArray(properties) ? (properties as Record<string, JsonSchema>) : undefined
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : []
    for (const key of required) {
      if (!Object.hasOwn(record, key)) throw new JsonSchemaValidationError(itemPath(path, key), 'is required')
    }
    if (propMap && Object.keys(propMap).length > MAX_PROPERTIES) {
      throw new JsonSchemaValidationError(path, 'too many properties in schema')
    }
    if (propMap) {
      for (const [key, child] of Object.entries(propMap)) {
        if (Object.hasOwn(record, key)) {
          validateValue(record[key], child, itemPath(path, key), depth + 1, seen)
        }
      }
    }
    const additional = schema.additionalProperties
    if (additional === false) {
      const allowed = new Set([...required, ...(propMap ? Object.keys(propMap) : [])])
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) throw new JsonSchemaValidationError(itemPath(path, key), 'is not allowed')
      }
    } else if (additional && typeof additional === 'object' && !Array.isArray(additional)) {
      const allowed = new Set([...required, ...(propMap ? Object.keys(propMap) : [])])
      for (const [key, childValue] of Object.entries(record)) {
        if (!allowed.has(key)) {
          validateValue(childValue, additional as JsonSchema, itemPath(path, key), depth + 1, seen)
        }
      }
    }
    seen.delete(value)
  }
}

function typeNames(type: unknown): string[] {
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string')
  return []
}

function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return true
  }
}

function numberKeyword(schema: JsonSchema, key: string): number | undefined {
  const value = schema[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function itemPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}