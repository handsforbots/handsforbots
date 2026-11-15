import type { Message } from '@handsforbots/core'
import {
  ATTR_KEY,
  cleanText,
  comparable,
  isRecord,
  ITEM_ID,
  MAX_ATTR_CHARS,
  MAX_ATTRS,
  MAX_EVIDENCE,
  MAX_OPS,
  MAX_QUOTE_CHARS,
  MAX_SCOPE_CHARS,
  MIN_QUOTE_CHARS,
  CONFIDENCE,
  type AttrValue,
  type Confidence,
  type Evidence,
  type Origin,
  type Rejection,
  type RejectReason,
  type Section,
  type Sections,
  type StateUpdate,
  type StateView,
  type ViewItem,
  type Writer,
} from './shared.js'

export type StateItem = {
  id: string
  text: string
  attrs?: Record<string, AttrValue>
  /** What it belongs to (a project, product, account). */
  scope?: string
  origin: Origin
  /** As asked by the writer, capped by the origin (see `capConfidence`). */
  confidence: Confidence
  evidence?: Evidence[]
  /** Set by the page: the backend can't change or remove it. */
  locked?: boolean
  /** Revision of the last change. */
  rev: number
  /** Revision that created it. */
  since: number
  by: Writer
  turnId?: string
  /** Time of the last change (ms). */
  at: number
}

/** One change in the journal: the item before and after (absent when added or removed). */
export type Change = { section: string; id: string; before?: StateItem; after?: StateItem; reason?: string }

export type JournalEntry = {
  revision: number
  at: number
  by: Writer
  turnId?: string
  /** `'update'` or `'revert'`. */
  kind: 'update' | 'revert'
  reason?: string
  changes: Change[]
  rejected: Rejection[]
}

/** Kept in `SessionSnapshot.conversationState` (or in memory with `persist: false`). */
export type StoredState = {
  v: 1
  revision: number
  items: Record<string, StateItem[]>
  journal: JournalEntry[]
}

export type UpdateResult = { revision: number; applied: Change[]; rejected: Rejection[] }

export type Limits = {
  sections: Sections
  maxChars: number
  maxRemovals: number
  journal: number
  screen?: (text: string, where: { section: string; by: Writer }) => string | false
}

export type ApplyContext = Limits & { by: Writer; turnId?: string; now: number; messages: readonly Message[] }

export const emptyState = (): StoredState => ({ v: 1, revision: 0, items: {}, journal: [] })

/** Characters an item costs in what is sent: its text and attrs. */
export function itemSize(item: Pick<StateItem, 'text' | 'attrs' | 'scope'>): number {
  return item.text.length + (item.scope?.length ?? 0) + (item.attrs ? JSON.stringify(item.attrs).length : 0)
}

export function stateSize(items: Record<string, StateItem[]>): number {
  let size = 0
  for (const list of Object.values(items)) for (const item of list) size += itemSize(item)
  return size
}

/** Text a quote is checked against: the message's text, or a tool's result. */
export function messageText(message: Message): string {
  if (message.role === 'tool') {
    let payload = ''
    try {
      payload = JSON.stringify(message.error ?? message.result ?? '') ?? ''
    } catch {
      /* unserializable result */
    }
    return `${message.name} ${message.error ?? ''} ${payload}`
  }
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

/**
 * Applies an update and returns the next state (the same object when
 * nothing changed and nothing was rejected). Pure: never throws.
 *
 * Each operation is checked on its own and a bad one is rejected with a
 * reason while the others go through. Two checks reject the whole update,
 * because they only make sense on the result: more removals than
 * `maxRemovals` (a model that "forgot" half of the state), and a result over
 * `maxChars`.
 */
export function applyUpdate(current: StoredState, update: unknown, context: ApplyContext): { next: StoredState; result: UpdateResult } {
  const rejected: Rejection[] = []
  const changes: Change[] = []
  const reject = (index: number, reason: RejectReason, op?: Record<string, unknown>, detail?: string) =>
    rejected.push({
      index,
      reason,
      ...(op && typeof op.op === 'string' ? { op: op.op } : {}),
      ...(op && typeof op.section === 'string' ? { section: op.section } : {}),
      ...(op && typeof op.id === 'string' ? { id: op.id } : {}),
      ...(detail ? { detail } : {}),
    })

  const done = (next: StoredState) => ({ next, result: { revision: next.revision, applied: changes, rejected } })

  if (!isRecord(update) || !Array.isArray(update.ops)) {
    reject(-1, 'invalid', undefined, 'expected { base?, ops: [...] }')
    return done(record(current, [], rejected, context, 'update'))
  }
  const base = typeof update.base === 'number' && Number.isInteger(update.base) ? update.base : undefined
  const ops = update.ops as unknown[]
  const revision = current.revision + 1
  const work: Record<string, StateItem[]> = { ...current.items }
  let removals = 0

  ops.forEach((raw, index) => {
    if (index >= MAX_OPS) return reject(index, 'invalid', undefined, `at most ${MAX_OPS} ops per update`)
    if (!isRecord(raw)) return reject(index, 'invalid')
    const op = raw
    const section = typeof op.section === 'string' ? op.section : undefined
    const spec = section && Object.hasOwn(context.sections, section) ? context.sections[section] : undefined
    if (!section || !spec) return reject(index, 'unknown-section', op)
    const kind = op.op
    if (kind !== 'set' && kind !== 'add' && kind !== 'update' && kind !== 'remove') return reject(index, 'invalid', op, 'op must be set, add, update or remove')
    if ((kind === 'set' && spec.kind !== 'value') || ((kind === 'add' || kind === 'update') && spec.kind !== 'list'))
      return reject(index, 'invalid', op, `${kind} does not apply to a ${spec.kind} section`)

    const list = work[section] ?? []
    const byApp = context.by === 'app'

    // Text
    let text: string | undefined
    if (op.text !== undefined) {
      const checked = checkText(op.text, spec, section, context)
      if (typeof checked !== 'string') return reject(index, checked.reason, op, checked.detail)
      text = checked
    } else if (kind === 'set' || kind === 'add') return reject(index, 'invalid', op, 'text is required')

    // Attrs
    let attrs: Record<string, AttrValue | null> | undefined
    if (op.attrs !== undefined && kind !== 'remove') {
      const checked = checkAttrs(op.attrs, kind === 'update', section, context)
      if ('reason' in checked) return reject(index, checked.reason as RejectReason, op, checked.detail as string)
      attrs = checked as Record<string, AttrValue | null>
    }

    // Scope and confidence
    let scope: string | null | undefined
    if (op.scope !== undefined && kind !== 'remove') {
      if (op.scope === null && kind === 'update') scope = null
      else {
        const checked = checkText(op.scope, { kind: 'value', description: '', maxChars: MAX_SCOPE_CHARS }, section, context)
        if (typeof checked !== 'string') return reject(index, checked.reason, op, `scope: ${checked.detail ?? checked.reason}`)
        scope = checked
      }
    }
    let asked: Confidence | undefined
    if (op.confidence !== undefined && kind !== 'remove') {
      if (!CONFIDENCE.includes(op.confidence as Confidence)) return reject(index, 'invalid', op, `confidence must be one of ${CONFIDENCE.join(', ')}`)
      asked = op.confidence as Confidence
    }

    // Evidence
    let evidence: Evidence[] | undefined
    if (op.evidence !== undefined) {
      const checked = checkEvidence(op.evidence, context.messages)
      if (!Array.isArray(checked)) return reject(index, checked.reason, op, checked.detail)
      evidence = checked
    }
    const origin = originOf(evidence, byApp)
    const needs = spec.evidence ?? 'none'
    const changesContent = kind !== 'remove' && (text !== undefined || kind !== 'update')
    if (!byApp && changesContent && needs !== 'none') {
      if (!evidence?.length) return reject(index, 'evidence-required', op, `${section} needs ${needs === 'quote' ? 'a message id and a verbatim quote' : 'a message id'}`)
      if (needs === 'quote' && !evidence.some((e) => e.quote)) return reject(index, 'evidence-required', op, `${section} needs a verbatim quote`)
    }

    // Target
    let target: StateItem | undefined
    if (kind === 'set') target = list[0]
    else if (kind === 'update' || (kind === 'remove' && spec.kind === 'list')) {
      if (typeof op.id !== 'string') return reject(index, 'invalid', op, 'id is required')
      target = list.find((item) => item.id === op.id)
      if (!target) return reject(index, 'unknown-item', op)
    } else if (kind === 'remove') {
      target = list[0]
      if (!target) return reject(index, 'unknown-item', op, 'the section is empty')
    }
    if (target) {
      if (target.locked && !byApp) return reject(index, 'locked', op)
      if (base !== undefined && target.rev > base) return reject(index, 'stale', op, `changed in revision ${target.rev}, after ${base}`)
      if (!byApp && (spec.keepUserStated ?? true) && target.origin === 'user' && origin !== 'user')
        return reject(index, 'user-stated', op, 'the user stated this; change it with evidence from a user message')
    }

    if (kind === 'remove') {
      const reason = typeof op.reason === 'string' ? cleanText(op.reason).slice(0, 200) : ''
      if (!reason) return reject(index, 'reason-required', op)
      removals++
      work[section] = list.filter((item) => item !== target)
      changes.push({ section, id: target!.id, before: target!, reason })
      return
    }

    const locked = byApp && typeof op.locked === 'boolean' ? op.locked : target?.locked
    const stamp = { rev: revision, by: context.by, at: context.now, ...(context.turnId ? { turnId: context.turnId } : {}) }

    if (kind === 'add') {
      // Same text in another scope is another thing ("Terraform" of two projects).
      const key = comparable(text!)
      const where = scope ? comparable(scope) : ''
      if (list.some((item) => comparable(item.text) === key && (item.scope ? comparable(item.scope) : '') === where)) return reject(index, 'duplicate', op, 'already there')
      if (list.length >= (spec.max ?? 20)) return reject(index, 'section-full', op, `at most ${spec.max ?? 20}; remove or merge items first`)
      let id: string
      if (op.id !== undefined) {
        if (typeof op.id !== 'string' || !ITEM_ID.test(op.id) || list.some((item) => item.id === op.id)) return reject(index, 'invalid', op, 'id must be new and match [A-Za-z0-9_.:-]{1,40}')
        id = op.id
      } else id = freshId(section, list)
      const item: StateItem = {
        id,
        text: text!,
        ...(attrs ? { attrs: dropNulls(attrs) } : {}),
        ...(scope ? { scope } : {}),
        origin,
        confidence: capConfidence(asked, origin),
        ...(evidence?.length ? { evidence } : {}),
        ...(locked ? { locked: true } : {}),
        since: revision,
        ...stamp,
      }
      work[section] = [...list, item]
      changes.push({ section, id, after: item })
      return
    }

    // set / update
    const nextText = text ?? target!.text
    const nextAttrs = kind === 'set' ? (attrs ? dropNulls(attrs) : undefined) : mergeAttrs(target!.attrs, attrs)
    const nextScope = scope === null ? undefined : (scope ?? (kind === 'update' ? target?.scope : undefined))
    const keepsContent = !!target && text === undefined
    // New text without new evidence loses the old evidence (it may not support the new text).
    const nextOrigin: Origin = evidence ? origin : keepsContent ? target!.origin : byApp ? 'app' : 'unsourced'
    const nextConfidence = capConfidence(asked ?? (evidence || !keepsContent ? undefined : target!.confidence), nextOrigin)
    if (
      target &&
      comparable(nextText) === comparable(target.text) &&
      sameAttrs(nextAttrs, target.attrs) &&
      nextScope === target.scope &&
      nextConfidence === target.confidence &&
      !evidence &&
      locked === target.locked
    )
      return reject(index, 'duplicate', op, 'no change')
    const item: StateItem = {
      id: target?.id ?? section,
      text: nextText,
      ...(nextAttrs && Object.keys(nextAttrs).length ? { attrs: nextAttrs } : {}),
      ...(nextScope ? { scope: nextScope } : {}),
      origin: nextOrigin,
      confidence: nextConfidence,
      ...(evidence ? { evidence } : keepsContent && target!.evidence ? { evidence: target!.evidence } : {}),
      ...(locked ? { locked: true } : {}),
      since: target && comparable(nextText) === comparable(target.text) ? target.since : revision,
      ...stamp,
    }
    work[section] = target ? list.map((i) => (i === target ? item : i)) : [item]
    changes.push({ section, id: item.id, ...(target ? { before: target } : {}), after: item })
  })

  if (changes.length > 0 && !(context.by === 'app')) {
    if (removals > context.maxRemovals) return rejectAll(current, changes, rejected, 'too-many-removals', `${removals} removals; at most ${context.maxRemovals} per update`, context)
  }
  if (changes.length > 0) {
    const size = stateSize(work)
    if (size > context.maxChars && size > stateSize(current.items))
      return rejectAll(current, changes, rejected, 'over-budget', `${size} characters; free ${size - context.maxChars} (limit ${context.maxChars})`, context)
  }
  if (changes.length === 0) return done(record(current, [], rejected, context, 'update'))
  for (const key of Object.keys(work)) if (work[key]!.length === 0) delete work[key]
  return done(record({ ...current, revision, items: work }, changes, rejected, context, 'update'))

  function rejectAll(state: StoredState, applied: Change[], earlier: Rejection[], reason: RejectReason, detail: string, ctx: ApplyContext) {
    // Nothing applies; every op that would have applied is listed with the reason.
    const failed = new Set(earlier.map((r) => r.index))
    const all = ops
      .map((op, index) => ({ op, index }))
      .filter(({ index }) => !failed.has(index) && index < MAX_OPS)
      .map(({ op, index }) => {
        const o = isRecord(op) ? op : {}
        return {
          index,
          reason,
          ...(typeof o.op === 'string' ? { op: o.op } : {}),
          ...(typeof o.section === 'string' ? { section: o.section } : {}),
          ...(typeof o.id === 'string' ? { id: o.id } : {}),
          detail,
        } satisfies Rejection
      })
    applied.length = 0
    rejected.push(...all)
    rejected.sort((a, b) => a.index - b.index)
    return done(record(state, [], rejected, ctx, 'update'))
  }
}

/**
 * Undoes every change made after `revision`, from the journal. Fails (and
 * changes nothing) when the journal no longer reaches that far back.
 */
export function revertTo(current: StoredState, revision: number, reason: string, context: Omit<ApplyContext, 'messages' | 'screen'>): { next: StoredState; result: UpdateResult } | { error: string } {
  if (!Number.isInteger(revision) || revision < 0 || revision >= current.revision) return { error: `revision must be an integer from 0 to ${current.revision - 1}` }
  const entries = current.journal.filter((e) => e.revision > revision && e.changes.length > 0)
  const covered = new Set(entries.map((e) => e.revision))
  for (let r = revision + 1; r <= current.revision; r++) if (!covered.has(r)) return { error: `the journal no longer has revision ${r}` }
  const next = current.revision + 1
  const work: Record<string, StateItem[]> = { ...current.items }
  const changes: Change[] = []
  for (const entry of [...entries].reverse()) {
    for (const change of [...entry.changes].reverse()) {
      const list = work[change.section] ?? []
      const now = list.find((item) => item.id === change.id)
      const restored = change.before ? { ...change.before, rev: next, at: context.now, by: context.by } : undefined
      const rest = list.filter((item) => item.id !== change.id)
      work[change.section] = restored ? (now ? list.map((i) => (i.id === change.id ? restored : i)) : [...rest, restored]) : rest
      changes.push({ section: change.section, id: change.id, ...(now ? { before: now } : {}), ...(restored ? { after: restored } : {}), reason })
    }
  }
  for (const key of Object.keys(work)) if (work[key]!.length === 0) delete work[key]
  const state = record({ ...current, revision: next, items: work }, changes, [], context, 'revert', reason)
  return { next: state, result: { revision: next, applied: changes, rejected: [] } }
}

/** What the backend receives. */
export function viewOf(state: StoredState, sections: Sections, rejected?: Rejection[]): StateView {
  const view: StateView['sections'] = {}
  for (const [name, spec] of Object.entries(sections)) {
    const items = (state.items[name] ?? []).map(toView)
    view[name] = spec.kind === 'value' ? (items[0] ?? null) : items
  }
  return { revision: state.revision, sections: view, ...(rejected?.length ? { rejected } : {}) }
}

function toView(item: StateItem): ViewItem {
  return {
    id: item.id,
    text: item.text,
    ...(item.attrs ? { attrs: item.attrs } : {}),
    ...(item.scope ? { scope: item.scope } : {}),
    origin: item.origin,
    confidence: item.confidence,
    ...(item.evidence?.length ? { src: item.evidence.map((e) => e.messageId) } : {}),
    ...(stated(item) ? { stated: stated(item) } : {}),
    ...(item.locked ? { locked: true as const } : {}),
  }
}

/**
 * Reads a stored state (from storage or another tab): keeps known sections
 * and well-formed items, drops the rest. Never throws.
 */
export function loadState(raw: unknown, sections: Sections): StoredState {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.items)) return emptyState()
  const revision = Number.isInteger(raw.revision) && (raw.revision as number) >= 0 ? (raw.revision as number) : 0
  const items: Record<string, StateItem[]> = {}
  for (const [name, list] of Object.entries(raw.items)) {
    if (!Object.hasOwn(sections, name) || !Array.isArray(list)) continue
    const kept = list.filter(isStoredItem).slice(0, sections[name]!.kind === 'value' ? 1 : 1000)
    if (kept.length) items[name] = kept
  }
  const journal = Array.isArray(raw.journal) ? (raw.journal.filter((e) => isRecord(e) && Number.isInteger(e.revision) && Array.isArray(e.changes)) as JournalEntry[]) : []
  return { v: 1, revision, items, journal }
}

function stated(item: StateItem): string | undefined {
  const times = (item.evidence ?? []).map((e) => e.at).filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined
}

/**
 * The confidence an item keeps: what the writer asked, never above what its
 * origin supports. The user, a tool result or the page: up to `'high'`
 * (default). The assistant's own message: up to `'medium'`. No evidence: `'low'`.
 */
export function capConfidence(asked: Confidence | undefined, origin: Origin): Confidence {
  const ceiling: Confidence = origin === 'unsourced' ? 'low' : origin === 'assistant' ? 'medium' : 'high'
  const rank = (c: Confidence) => CONFIDENCE.indexOf(c) // 0 = high
  const wanted = asked ?? ceiling
  return rank(wanted) >= rank(ceiling) ? wanted : ceiling
}

function isStoredItem(value: unknown): value is StateItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    typeof value.origin === 'string' &&
    CONFIDENCE.includes(value.confidence as Confidence) &&
    Number.isInteger(value.rev) &&
    Number.isInteger(value.since)
  )
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

type Failure = { reason: RejectReason; detail?: string }

function checkText(raw: unknown, spec: Section, section: string, context: ApplyContext): string | Failure {
  if (typeof raw !== 'string') return { reason: 'invalid', detail: 'text must be a string' }
  let text = cleanText(raw)
  if (context.screen) {
    let screened: string | false
    try {
      screened = context.screen(text, { section, by: context.by })
    } catch {
      screened = false
    }
    if (screened === false) return { reason: 'screened' }
    text = cleanText(screened)
  }
  if (!text) return { reason: 'invalid', detail: 'text is empty' }
  const max = spec.maxChars ?? 300
  // Never cut: a cut sentence can say something else.
  if (text.length > max) return { reason: 'too-long', detail: `${text.length} characters; at most ${max}` }
  if (spec.values && !spec.values.includes(text)) return { reason: 'not-allowed-value', detail: `one of: ${spec.values.join(', ')}` }
  return text
}

function checkAttrs(raw: unknown, allowNull: boolean, section: string, context: ApplyContext): Record<string, AttrValue | null> | Failure {
  if (!isRecord(raw)) return { reason: 'invalid', detail: 'attrs must be an object' }
  const entries = Object.entries(raw)
  if (entries.length > MAX_ATTRS) return { reason: 'invalid', detail: `at most ${MAX_ATTRS} attrs` }
  const out: Record<string, AttrValue | null> = {}
  for (const [key, value] of entries) {
    if (!ATTR_KEY.test(key)) return { reason: 'invalid', detail: `attr name "${key.slice(0, 40)}"` }
    if (value === null && allowNull) out[key] = null
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value
    else if (typeof value === 'string') {
      const checked = checkText(value, { kind: 'value', description: '', maxChars: MAX_ATTR_CHARS }, section, context)
      if (typeof checked !== 'string') return { reason: checked.reason, detail: `attr ${key}: ${checked.detail ?? checked.reason}` }
      out[key] = checked
    } else return { reason: 'invalid', detail: `attr ${key} must be a string, number or boolean` }
  }
  return out
}

function checkEvidence(raw: unknown, messages: readonly Message[]): Evidence[] | Failure {
  if (!Array.isArray(raw)) return { reason: 'invalid', detail: 'evidence must be an array' }
  if (raw.length > MAX_EVIDENCE) return { reason: 'invalid', detail: `at most ${MAX_EVIDENCE} evidence items` }
  const out: Evidence[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.messageId !== 'string') return { reason: 'invalid', detail: 'evidence items need a messageId' }
    const message = messages.find((m) => m.id === entry.messageId)
    if (!message) return { reason: 'evidence-not-found', detail: `no message ${entry.messageId.slice(0, 60)} in this conversation` }
    const evidence: Evidence = { messageId: message.id, role: message.role, at: message.createdAt }
    if (entry.quote !== undefined) {
      if (typeof entry.quote !== 'string') return { reason: 'invalid', detail: 'quote must be a string' }
      const quote = cleanText(entry.quote)
      if (quote.length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS)
        return { reason: 'invalid', detail: `quote must have ${MIN_QUOTE_CHARS} to ${MAX_QUOTE_CHARS} characters` }
      // The deterministic check against invented facts: the quote must be in the message.
      if (!comparable(messageText(message)).includes(comparable(quote).replace(/^["'.\s]+|["'.\s]+$/g, '')))
        return { reason: 'quote-not-found', detail: `the quote is not in message ${message.id}` }
      evidence.quote = quote
    }
    out.push(evidence)
  }
  return out
}

function originOf(evidence: Evidence[] | undefined, byApp: boolean): Origin {
  if (!evidence?.length) return byApp ? 'app' : 'unsourced'
  if (evidence.some((e) => e.role === 'user')) return 'user'
  if (evidence.some((e) => e.role === 'tool')) return 'tool'
  return 'assistant'
}

function freshId(section: string, list: StateItem[]): string {
  const prefix = section.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toLowerCase() || 'i'
  let n = list.length + 1
  while (list.some((item) => item.id === `${prefix}${n}`)) n++
  return `${prefix}${n}`
}

function dropNulls(attrs: Record<string, AttrValue | null>): Record<string, AttrValue> {
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== null)) as Record<string, AttrValue>
}

function mergeAttrs(before: Record<string, AttrValue> | undefined, change: Record<string, AttrValue | null> | undefined): Record<string, AttrValue> | undefined {
  if (!change) return before
  const merged = dropNulls({ ...before, ...change })
  return Object.keys(merged).length ? merged : undefined
}

function sameAttrs(a: Record<string, AttrValue> | undefined, b: Record<string, AttrValue> | undefined): boolean {
  const ak = Object.keys(a ?? {})
  const bk = Object.keys(b ?? {})
  return ak.length === bk.length && ak.every((k) => a![k] === b?.[k])
}

function record(state: StoredState, changes: Change[], rejected: Rejection[], context: Pick<ApplyContext, 'by' | 'turnId' | 'now' | 'journal'>, kind: 'update' | 'revert', reason?: string): StoredState {
  if (changes.length === 0 && rejected.length === 0) return state
  const entry: JournalEntry = {
    revision: state.revision,
    at: context.now,
    by: context.by,
    ...(context.turnId ? { turnId: context.turnId } : {}),
    kind,
    ...(reason ? { reason } : {}),
    changes,
    rejected,
  }
  return { ...state, journal: [...state.journal, entry].slice(-Math.max(1, context.journal)) }
}
