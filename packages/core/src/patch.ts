import type { JsonPatchOperation } from './types.js'

const MAX_OPERATIONS = 1000
const MAX_PATH_DEPTH = 32

/** Applies RFC 6902 operations immutably. Supports add, remove, replace, move, copy and test. */
export function applyPatch<T>(document: T, operations: JsonPatchOperation[]): T {
  if (operations.length > MAX_OPERATIONS) throw new Error(`JSON patch exceeds ${MAX_OPERATIONS} operations`)
  let doc: unknown = structuredClone(document)
  for (const op of operations) {
    switch (op.op) {
      case 'add':
        doc = setAt(doc, parse(op.path), op.value, 'add')
        break
      case 'replace':
        doc = setAt(doc, parse(op.path), op.value, 'replace')
        break
      case 'remove':
        doc = removeAt(doc, parse(op.path))
        break
      case 'copy':
        doc = setAt(doc, parse(op.path), structuredClone(getAt(doc, parse(op.from ?? ''))), 'add')
        break
      case 'move': {
        const from = parse(op.from ?? '')
        const value = getAt(doc, from)
        if (value === undefined) throw new Error(`JSON patch move source missing at ${op.from ?? ''}`)
        doc = setAt(removeAt(doc, from), parse(op.path), value, 'add')
        break
      }
      case 'test': {
        const current = getAt(doc, parse(op.path))
        if (current === undefined) throw new Error(`JSON patch test failed: missing target at ${op.path}`)
        if (JSON.stringify(current) !== JSON.stringify(op.value)) {
          throw new Error(`JSON patch test failed at ${op.path}`)
        }
        break
      }
      default: {
        const _never: never = op.op
        throw new Error(`Unknown JSON patch operation ${String(_never)}`)
      }
    }
  }
  return doc as T
}

function parse(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new Error(`Invalid JSON pointer "${path}"`)
  const segments = path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (segments.length > MAX_PATH_DEPTH) throw new Error(`JSON pointer "${path}" exceeds depth ${MAX_PATH_DEPTH}`)
  if (segments.includes('__proto__')) throw new Error(`JSON pointer "${path}" uses "__proto__"`)
  return segments
}

const ARRAY_INDEX = /^(0|[1-9]\d*)$/

function parseArrayIndex(key: string, allowDash: boolean): number {
  if (allowDash && key === '-') return -1
  if (!ARRAY_INDEX.test(key)) throw new Error(`Invalid array index "${key}"`)
  return Number(key)
}

/** Walks own properties only, so a path never reaches a prototype. */
function getAt(doc: unknown, path: string[]): unknown {
  let current: unknown = doc
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      if (key === '-') return undefined
      if (!ARRAY_INDEX.test(key)) return undefined
      const index = Number(key)
      if (index >= current.length) return undefined
      current = current[index]
      continue
    }
    const record = current as Record<string, unknown>
    if (!Object.hasOwn(record, key)) return undefined
    current = record[key]
  }
  return current
}

function parentAt(doc: unknown, path: string[]): unknown {
  return getAt(doc, path.slice(0, -1))
}

function setAt(doc: unknown, path: string[], value: unknown, mode: 'add' | 'replace'): unknown {
  if (path.length === 0) return value
  const key = path[path.length - 1]!
  const parent = parentAt(doc, path)
  if (parent === undefined) throw new Error(`Invalid JSON patch path /${path.join('/')}`)
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key, mode === 'add')
    if (index === -1) {
      parent.push(value)
      return doc
    }
    if (mode === 'add' && index > parent.length) {
      throw new Error(`JSON patch add index ${index} is past array end`)
    }
    if (mode === 'replace' && (index < 0 || index >= parent.length)) {
      throw new Error(`JSON patch replace target missing at /${path.join('/')}`)
    }
    if (mode === 'add') parent.splice(index, 0, value)
    else parent[index] = value
    return doc
  }
  if (parent === null || typeof parent !== 'object') throw new Error(`Invalid JSON patch path /${path.join('/')}`)
  if (mode === 'replace' && !Object.hasOwn(parent as Record<string, unknown>, key)) {
    throw new Error(`JSON patch replace target missing at /${path.join('/')}`)
  }
  ;(parent as Record<string, unknown>)[key] = value
  return doc
}

function removeAt(doc: unknown, path: string[]): unknown {
  if (path.length === 0) return undefined
  const key = path[path.length - 1]!
  const parent = parentAt(doc, path)
  if (parent === undefined) throw new Error(`JSON patch remove target missing at /${path.join('/')}`)
  if (Array.isArray(parent)) {
    if (key === '-') throw new Error('JSON patch cannot remove the "-" placeholder index')
    const index = parseArrayIndex(key, false)
    if (index >= parent.length) throw new Error(`JSON patch remove target missing at /${path.join('/')}`)
    parent.splice(index, 1)
    return doc
  }
  if (parent === null || typeof parent !== 'object') throw new Error(`JSON patch remove target missing at /${path.join('/')}`)
  if (!Object.hasOwn(parent as Record<string, unknown>, key)) {
    throw new Error(`JSON patch remove target missing at /${path.join('/')}`)
  }
  delete (parent as Record<string, unknown>)[key]
  return doc
}