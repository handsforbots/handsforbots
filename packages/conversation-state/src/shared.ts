/**
 * Shapes and checks shared by the plugin (`.`) and the backend helpers
 * (`./server`). No imports: the server entry must run without the browser
 * or `@handsforbots/core`.
 */

/** Context signal key, `ui.effect` name and `data` part name. */
export const STATE_KEY = 'conversation.state'
/** Action the assistant may call to update the state. */
export const STATE_ACTION = 'update_conversation_state'

export type AttrValue = string | number | boolean

/**
 * A section of the state. `value` holds one item (the active topic, the
 * goal); `list` holds several (entities, decisions, facts, pending).
 */
export type Section = {
  kind: 'value' | 'list'
  /** What goes here. Sent to the model in the action's schema and in `conversationStatePrompt`. */
  description: string
  /** Most items in a list. Default 20. A `value` holds one. */
  max?: number
  /** Most characters in an item's text. Default 300. */
  maxChars?: number
  /** Closed vocabulary for the text (for example depth levels). */
  values?: readonly string[]
  /**
   * What a backend write must point to: `'none'` (default), `'message'` (the
   * id of a message that supports it) or `'quote'` (a message id and a
   * verbatim quote found in that message). The page writes without it.
   */
  evidence?: 'none' | 'message' | 'quote'
  /**
   * An item the user stated (its evidence points to a user message) can only
   * be changed or removed with evidence from a user message, or by the page.
   * Default true; off for sections that move every turn, such as the topic.
   */
  keepUserStated?: boolean
}

export type Sections = Readonly<Record<string, Section>>

/** The sections used when `conversationState()` gets none. */
export const DEFAULT_SECTIONS = {
  topic: {
    kind: 'value',
    description: 'The subject being discussed right now, naming the project or product it belongs to.',
    maxChars: 160,
    keepUserStated: false,
  },
  goal: { kind: 'value', description: 'What the user wants to achieve, in their terms.', maxChars: 240 },
  depth: {
    kind: 'value',
    description: 'How deep the conversation is now (for example: overview, step by step, expert detail).',
    maxChars: 60,
    keepUserStated: false,
  },
  entities: {
    kind: 'list',
    description: 'Things being talked about (projects, products, files, people), with versions and dates as attrs.',
    max: 20,
    maxChars: 120,
  },
  decisions: { kind: 'list', description: 'What was decided, with the message where it was decided.', max: 15, maxChars: 240, evidence: 'message' },
  facts: {
    kind: 'list',
    description: 'Facts already stated in the conversation, each with the message that states it and a verbatim quote.',
    max: 25,
    maxChars: 240,
    evidence: 'quote',
  },
  pending: { kind: 'list', description: 'Open questions and things still to do.', max: 15, maxChars: 200 },
} as const satisfies Record<string, Section>

/** Who wrote a change: the backend (response, action or updater) or the page. */
export type Writer = 'backend' | 'app'

/**
 * Where an item's content comes from, worked out from its evidence (never
 * taken from the writer's word): the role of the messages it points to,
 * `'app'` for the page, `'unsourced'` for a backend write without evidence.
 */
export type Origin = 'user' | 'assistant' | 'tool' | 'app' | 'unsourced'

/**
 * How sure the writer is. The writer's word is capped by the evidence: a
 * claim backed only by the assistant's own message is at most `'medium'`,
 * and one without evidence is `'low'`.
 */
export type Confidence = 'high' | 'medium' | 'low'
export const CONFIDENCE: readonly Confidence[] = ['high', 'medium', 'low']

export type Evidence = {
  messageId: string
  /** Verbatim text found in that message when the change was applied. */
  quote?: string
  /** Role of the message, recorded when the change was applied. */
  role?: 'user' | 'assistant' | 'tool'
  /** When that message was created (ms). */
  at?: number
}

/** Fields an item can carry besides its text. */
type ItemFields = {
  attrs?: Record<string, AttrValue>
  /** What the item belongs to, such as a project (`'acme'`), so "the Terraform of that project" isn't mixed with another one. */
  scope?: string
  confidence?: Confidence
  evidence?: EvidenceInput[]
}

export type StateOp =
  /** Sets a `value` section. */
  | ({ op: 'set'; section: string; text: string; locked?: boolean } & ItemFields)
  /** Adds to a `list` section. `id` is optional (one is made up). */
  | ({ op: 'add'; section: string; text: string; id?: string; locked?: boolean } & ItemFields)
  /** Changes a list item: new text, attrs merged (`null` removes one), scope (`null` removes it), confidence, new evidence. */
  | ({ op: 'update'; section: string; id: string; text?: string; attrs?: Record<string, AttrValue | null>; scope?: string | null } & Omit<ItemFields, 'attrs' | 'scope'>)
  /** Removes a list item (`id`) or clears a value section. Always with a reason. */
  | { op: 'remove'; section: string; id?: string; reason: string; evidence?: EvidenceInput[] }

export type EvidenceInput = { messageId: string; quote?: string }

/**
 * An update: operations on the state, never a whole new state. `base` is
 * the revision it was computed from; changes to items modified after it are
 * rejected as `stale`.
 */
export type StateUpdate = { base?: number; ops: StateOp[] }

export type RejectReason =
  | 'invalid'
  | 'unknown-section'
  | 'unknown-item'
  | 'not-allowed-value'
  | 'too-long'
  | 'evidence-required'
  | 'evidence-not-found'
  | 'quote-not-found'
  | 'user-stated'
  | 'locked'
  | 'stale'
  | 'duplicate'
  | 'section-full'
  | 'reason-required'
  | 'screened'
  | 'over-budget'
  | 'too-many-removals'

export type Rejection = { index: number; reason: RejectReason; op?: string; section?: string; id?: string; detail?: string }

/** An item as the backend sees it. */
export type ViewItem = {
  id: string
  text: string
  attrs?: Record<string, AttrValue>
  scope?: string
  origin: Origin
  confidence: Confidence
  /** Ids of the messages it points to. */
  src?: string[]
  /** When the newest of those messages was written (ISO 8601). */
  stated?: string
  locked?: true
}

/**
 * What goes to the backend with each request, as the context signal
 * `conversation.state`: the revision, each section (a value section is an
 * item or null) and, once, what the last update had rejected.
 */
export type StateView = {
  revision: number
  sections: Record<string, ViewItem | ViewItem[] | null>
  rejected?: Rejection[]
}

/* -------------------------------------------------------------------------- */
/* Text                                                                       */
/* -------------------------------------------------------------------------- */

// Control characters, zero-width and bidi controls, tag characters: invisible text that can hide instructions.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu

/** Removes invisible characters and collapses whitespace into single spaces. */
export function cleanText(text: string): string {
  return text.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
}

/** For comparing: case, quote marks, dashes and whitespace don't matter. */
export function comparable(text: string): string {
  return cleanText(text.normalize('NFKC'))
    .toLowerCase()
    .replace(/[“”„«»]/g, '"')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
}

export const ITEM_ID = /^[A-Za-z0-9_.:-]{1,40}$/
export const ATTR_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/
export const MAX_ATTRS = 8
export const MAX_ATTR_CHARS = 120
export const MAX_EVIDENCE = 5
export const MAX_QUOTE_CHARS = 300
export const MIN_QUOTE_CHARS = 3
export const MAX_OPS = 50
export const MAX_SCOPE_CHARS = 64

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* -------------------------------------------------------------------------- */
/* What the model needs to know                                               */
/* -------------------------------------------------------------------------- */

/** JSON Schema of a `StateUpdate` for these sections (the action's parameters; also for structured output). */
export function stateUpdateSchema(sections: Sections = DEFAULT_SECTIONS): Record<string, unknown> {
  const names = Object.keys(sections)
  const evidence = {
    type: 'array',
    maxItems: MAX_EVIDENCE,
    description: 'Messages that support this change. quote: text copied verbatim from that message.',
    items: {
      type: 'object',
      properties: { messageId: { type: 'string' }, quote: { type: 'string', maxLength: MAX_QUOTE_CHARS } },
      required: ['messageId'],
      additionalProperties: false,
    },
  }
  const attrs = {
    type: 'object',
    description: 'Short attributes such as version, date or project.',
    additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
  }
  return {
    type: 'object',
    properties: {
      base: { type: 'integer', description: 'The state revision this update was computed from.' },
      ops: {
        type: 'array',
        maxItems: MAX_OPS,
        description: `Changes, applied in order. Sections: ${names
          .map((name) => `${name} (${sections[name]!.kind}${sections[name]!.evidence && sections[name]!.evidence !== 'none' ? `, evidence: ${sections[name]!.evidence}` : ''}): ${sections[name]!.description}`)
          .join(' | ')}`,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['set', 'add', 'update', 'remove'], description: 'set: value sections. add/update: list sections. remove: either (id for lists).' },
            section: { type: 'string', enum: names },
            id: { type: 'string', description: 'Item id (update, remove; optional on add).' },
            text: { type: 'string' },
            attrs,
            scope: { type: ['string', 'null'], maxLength: MAX_SCOPE_CHARS, description: 'What it belongs to (a project, product or account), to tell apart things with the same name.' },
            confidence: { type: 'string', enum: CONFIDENCE, description: 'high only for what the user or a tool result said; your own inferences are medium at most.' },
            evidence,
            reason: { type: 'string', description: 'Why it is removed (required on remove).' },
          },
          required: ['op', 'section'],
          additionalProperties: false,
        },
      },
    },
    required: ['ops'],
    additionalProperties: false,
  }
}

/** Instructions for the model that keeps the state (system prompt or updater prompt). */
export function conversationStatePrompt(sections: Sections = DEFAULT_SECTIONS): string {
  const lines = Object.entries(sections).map(([name, s]) => {
    const rules = [
      s.kind === 'value' ? 'one value' : `list, at most ${s.max ?? 20}`,
      `up to ${s.maxChars ?? 300} characters`,
      s.values ? `only: ${s.values.join(', ')}` : '',
      s.evidence === 'quote' ? 'needs a message id and a verbatim quote' : s.evidence === 'message' ? 'needs a message id' : '',
    ].filter(Boolean)
    return `- ${name}: ${s.description} (${rules.join('; ')})`
  })
  return [
    'You keep a small explicit state of this conversation, sent as "conversation.state". It is not a summary: record only what the messages support, as short atomic claims (one claim per item), each with its source, scope and confidence.',
    'Sections:',
    ...lines,
    'Rules:',
    '- Send only changes (ops), never the whole state, with "base" set to the revision you read.',
    '- Do not record guesses as facts. If nobody said it, leave it out or put it in pending.',
    '- Give scope (the project, product or account) whenever the same name could belong to more than one.',
    '- confidence: high only for what the user or a tool result said; medium for your own inferences; low when unsure.',
    '- Evidence points to message ids from this conversation; a quote must be copied verbatim from that message.',
    '- What the user stated (origin "user") changes only with evidence from a newer user message.',
    '- Remove with a reason. Items marked locked are set by the page; do not change them.',
    '- If "rejected" lists problems with your last update, fix them or drop the change.',
  ].join('\n')
}
