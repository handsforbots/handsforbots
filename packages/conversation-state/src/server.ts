/**
 * For the backend (Node, Deno, edge): reads the `conversation.state` the page
 * sends (ADR 0019) and tells the model how to update it. No dependency on
 * the browser or on `@handsforbots/core`.
 *
 * The state comes from the browser, so anyone can edit it: treat it as what
 * the conversation says, not as authorization.
 */
import {
  CONFIDENCE,
  isRecord,
  STATE_KEY,
  type Confidence,
  type Origin,
  type Rejection,
  type StateView,
  type ViewItem,
} from './shared.js'

export {
  conversationStatePrompt,
  DEFAULT_SECTIONS,
  STATE_ACTION,
  STATE_KEY,
  stateUpdateSchema,
  type AttrValue,
  type Confidence,
  type Origin,
  type Rejection,
  type Section,
  type Sections,
  type StateOp,
  type StateUpdate,
  type StateView,
  type ViewItem,
} from './shared.js'

export type ReadStateOptions = {
  /** Sections kept (others are dropped). Default: all. */
  sections?: readonly string[]
  /** Most items per section. Default 100. */
  maxItems?: number
  /** Most characters in a text. Default 2000. */
  maxChars?: number
}

const ORIGINS: readonly Origin[] = ['user', 'assistant', 'tool', 'app', 'unsourced']

/**
 * Finds and checks the state in what the transport sent:
 * - the AG-UI `context` array (`{ description, value: 'conversation.state: {…}' }`);
 * - the context object of `@handsforbots/transport-http` (`{ 'conversation.state': [{…}] }`);
 * - an array of H4B signals (a `data` part named `conversation.state`);
 * - the value itself, as an object or a string.
 *
 *   const state = readConversationState(input.context)
 *   const project = state?.sections.topic
 *
 * Returns undefined when there is none; drops malformed items. Never throws.
 */
export function readConversationState(source: unknown, options: ReadStateOptions = {}): StateView | undefined {
  const raw = locate(source)
  if (!isRecord(raw) || !isRecord(raw.sections) || !Number.isInteger(raw.revision) || (raw.revision as number) < 0) return undefined
  const maxItems = options.maxItems ?? 100
  const maxChars = options.maxChars ?? 2000
  const sections: StateView['sections'] = {}
  for (const [name, value] of Object.entries(raw.sections)) {
    if (options.sections && !options.sections.includes(name)) continue
    if (value === null) sections[name] = null
    else if (Array.isArray(value)) sections[name] = value.slice(0, maxItems).map((v) => item(v, maxChars)).filter((v): v is ViewItem => !!v)
    else {
      const one = item(value, maxChars)
      if (one) sections[name] = one
    }
  }
  const view: StateView = { revision: raw.revision as number, sections }
  if (Array.isArray(raw.rejected)) {
    const rejected = raw.rejected.filter((r): r is Rejection => isRecord(r) && typeof r.reason === 'string' && typeof r.index === 'number').slice(0, 50)
    if (rejected.length) view.rejected = rejected
  }
  return view
}

/** Items of every section, flattened, optionally only those of one scope (`'acme'`). */
export function stateItems(view: StateView | undefined, filter: { scope?: string } = {}): Array<ViewItem & { section: string }> {
  if (!view) return []
  const out: Array<ViewItem & { section: string }> = []
  for (const [section, value] of Object.entries(view.sections)) {
    for (const entry of value === null ? [] : Array.isArray(value) ? value : [value]) {
      if (filter.scope === undefined || entry.scope === filter.scope) out.push({ ...entry, section })
    }
  }
  return out
}

function item(value: unknown, maxChars: number): ViewItem | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.text !== 'string') return undefined
  if (value.text.length > maxChars || value.id.length > 64) return undefined
  const origin = ORIGINS.includes(value.origin as Origin) ? (value.origin as Origin) : 'unsourced'
  const confidence = CONFIDENCE.includes(value.confidence as Confidence) ? (value.confidence as Confidence) : 'low'
  const out: ViewItem = { id: value.id, text: value.text, origin, confidence }
  if (typeof value.scope === 'string' && value.scope.length <= 64) out.scope = value.scope
  if (isRecord(value.attrs)) {
    const attrs = Object.entries(value.attrs).filter(
      ([k, v]) => k.length <= 32 && (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200)),
    )
    if (attrs.length) out.attrs = Object.fromEntries(attrs.slice(0, 16)) as ViewItem['attrs']
  }
  if (Array.isArray(value.src)) {
    const src = value.src.filter((s): s is string => typeof s === 'string' && s.length <= 128).slice(0, 10)
    if (src.length) out.src = src
  }
  if (typeof value.stated === 'string' && !Number.isNaN(Date.parse(value.stated))) out.stated = value.stated
  if (value.locked === true) out.locked = true
  return out
}

function parse(text: string): unknown {
  const trimmed = text.trim()
  const body = trimmed.startsWith(`${STATE_KEY}:`) ? trimmed.slice(STATE_KEY.length + 1) : trimmed
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function locate(source: unknown): unknown {
  if (typeof source === 'string') return parse(source)
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (!isRecord(entry)) continue
      if (Array.isArray(entry.parts)) {
        const part = entry.parts.find((p: unknown) => isRecord(p) && p.type === 'data' && p.name === STATE_KEY)
        if (isRecord(part)) return part.value
        continue
      }
      if (typeof entry.value === 'string' && entry.value.trim().startsWith(`${STATE_KEY}:`)) return parse(entry.value)
    }
    return undefined
  }
  if (isRecord(source)) {
    if (Object.hasOwn(source, STATE_KEY)) {
      const value = source[STATE_KEY]
      return Array.isArray(value) ? value[0] : value
    }
    return source
  }
  return undefined
}
