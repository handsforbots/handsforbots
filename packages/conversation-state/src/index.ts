import { definePlugin, type Message, type PluginDefinition, type Signal } from '@handsforbots/core'
import {
  applyUpdate,
  emptyState,
  loadState,
  revertTo,
  stateSize,
  viewOf,
  type JournalEntry,
  type StateItem,
  type StoredState,
  type UpdateResult,
} from './apply.js'
import {
  DEFAULT_SECTIONS,
  STATE_ACTION,
  STATE_KEY,
  stateUpdateSchema,
  type Rejection,
  type Sections,
  type StateUpdate,
  type StateView,
  type Writer,
} from './shared.js'

export * from './shared.js'
export { capConfidence, messageText, type Change, type JournalEntry, type StateItem, type StoredState, type UpdateResult } from './apply.js'

/**
 * Updates the state on a channel of its own, after each finished turn
 * (`updates: updater`). Gets the state, the turn's messages and an abort
 * signal (a new conversation aborts it); returns operations, or nothing.
 */
export type StateUpdater = (input: {
  state: StateView
  /** Messages of the turn that just finished. */
  messages: Message[]
  threadId: string
  turnId: string
  signal: AbortSignal
}) => StateUpdate | undefined | Promise<StateUpdate | undefined>

export type ConversationStateOptions = {
  /** The sections. Default `DEFAULT_SECTIONS`; spread it to add your own. */
  sections?: Sections
  /**
   * Where updates come from:
   * - `'response'` (default): with the reply, as a `ui.effect` named
   *   `conversation.state` (applied when the turn ends, so quotes from the
   *   whole reply can be checked) or as the `update_conversation_state` action;
   * - a `StateUpdater` (such as `httpStateUpdater`): a channel of its own,
   *   called after each finished turn;
   * - `'manual'`: only `h4b.get('conversationState').update()`.
   */
  updates?: 'response' | 'manual' | StateUpdater
  /** Registers the `update_conversation_state` action. Default true with `updates: 'response'`. */
  action?: boolean
  /** Saves the state with the conversation (`SessionSnapshot.conversationState`), so the storage plugins keep it. Default true; false keeps it in memory for this tab. */
  persist?: boolean
  /** Sends the state with every request as the context signal `conversation.state`. Default true. */
  send?: boolean
  /** Most characters for all items (text, scope and attrs). An update that goes over is rejected whole. Default 4000. */
  maxChars?: number
  /** Most removals in one backend update; more rejects the whole update. Default 3. */
  maxRemovals?: number
  /** Journal entries kept for audit and `revert()`. Default 50. */
  journal?: number
  /**
   * Last word on every text before it is stored (after invisible characters
   * are removed): return the text (changed or not), or false to reject the
   * operation (`screened`). Use it to redact personal data or block
   * instructions aimed at the model.
   */
  screen?: (text: string, where: { section: string; by: Writer }) => string | false
  /** How long a request waits for an updater still running before it goes with the state it has (ms). Default 2000. */
  wait?: number
}

export type ConversationStateSnapshot = {
  revision: number
  /** Items per section, in order. */
  items: Readonly<Record<string, readonly StateItem[]>>
  /** Characters used, against `maxChars`. */
  size: number
  /** An updater is running. */
  pending: boolean
  /** What the last update rejected (until the next one). */
  rejected: readonly Rejection[]
}

/** The `conversationState` service. */
export type ConversationStateControl = {
  readonly sections: Sections
  /** For `useStore` (React, Vue) and the page. Same object until something changes. */
  getState(): ConversationStateSnapshot
  subscribe(listener: () => void): () => void
  /** What the backend receives. */
  view(): StateView
  /** Applies an update. `by: 'app'` (default) is the page: no evidence needed, may lock items and change locked ones. */
  update(update: StateUpdate, options?: { by?: Writer; turnId?: string }): UpdateResult
  /** Undoes every change after `revision` (recorded as a new revision). Throws if the journal no longer reaches it. */
  revert(revision: number, reason: string): UpdateResult
  /** The journal: every change (before and after) and every rejection, oldest first. */
  history(): readonly JournalEntry[]
  /** Resolves when no updater is running. */
  settled(): Promise<void>
}

declare module '@handsforbots/core' {
  interface Services {
    conversationState: ConversationStateControl
  }
  interface Events {
    /** The explicit state changed, an update was rejected, or the state was restored or reset with the conversation. */
    'conversation.state': {
      revision: number
      reason: 'update' | 'revert' | 'restored' | 'reset'
      by?: Writer
      applied: number
      rejected: readonly Rejection[]
    }
  }
}

const SOURCE = 'conversation-state'

const definition: PluginDefinition<ConversationStateOptions | undefined> = {
  name: 'conversation-state',
  provides: ['conversationState'],
  apply(ctx, options = {}) {
    const app = ctx.app
    const conversation = app.conversation
    const sections: Sections = options.sections ?? DEFAULT_SECTIONS
    const updates = options.updates ?? 'response'
    const persist = options.persist !== false
    const limits = {
      sections,
      maxChars: options.maxChars ?? 4000,
      maxRemovals: options.maxRemovals ?? 3,
      journal: options.journal ?? 50,
      ...(options.screen ? { screen: options.screen } : {}),
    }
    const wait = options.wait ?? 2000

    /* -------------------------------------------------------------- */
    /* Where the state lives                                          */
    /* -------------------------------------------------------------- */

    let local: StoredState = emptyState()
    /** Last state this plugin wrote or accepted: a restore that goes back from it is undone. */
    let seen: StoredState = local
    let lastRaw: unknown = Symbol('none')
    let current: StoredState = emptyState()
    let threadId = conversation.threadId

    const read = (): StoredState => {
      if (!persist) return local
      const raw = conversation.conversationState
      if (raw !== lastRaw) {
        lastRaw = raw
        current = raw === undefined ? emptyState() : loadState(raw, sections)
      }
      return current
    }
    const write = (next: StoredState) => {
      seen = next
      if (persist) {
        conversation.conversationState = next
        lastRaw = next
        current = next
      } else local = next
    }

    /* -------------------------------------------------------------- */
    /* Store for the page                                             */
    /* -------------------------------------------------------------- */

    const listeners = new Set<() => void>()
    let running = 0
    let lastRejected: readonly Rejection[] = []
    let feedback: Rejection[] | undefined
    let snapshot: ConversationStateSnapshot | undefined
    let snapshotOf: StoredState | undefined
    const getState = (): ConversationStateSnapshot => {
      const state = read()
      if (!snapshot || snapshotOf !== state || snapshot.pending !== running > 0 || snapshot.rejected !== lastRejected) {
        snapshotOf = state
        snapshot = { revision: state.revision, items: state.items, size: stateSize(state.items), pending: running > 0, rejected: lastRejected }
      }
      return snapshot
    }
    const publish = () => {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          ctx.emit('error', { error, source: SOURCE })
        }
      }
    }

    const save = async () => {
      // The kernel saves at the end of each job; changes made outside one are saved here.
      if (!persist || app.busy) return
      try {
        await app.get('storage')?.save(conversation.snapshot())
      } catch (error) {
        ctx.emit('error', { error, source: 'storage' })
      }
    }

    const commit = (before: StoredState, next: StoredState, result: UpdateResult, by: Writer, reason: 'update' | 'revert') => {
      if (next !== before) write(next)
      if (next === before && result.rejected.length === 0) return
      lastRejected = result.rejected
      if (by === 'backend') feedback = result.rejected.length ? result.rejected : undefined
      ctx.emit('conversation.state', { revision: next.revision, reason, by, applied: result.applied.length, rejected: result.rejected })
      publish()
      if (next !== before) void save()
    }

    const update = (input: StateUpdate | unknown, by: Writer, turnId?: string): UpdateResult => {
      const before = read()
      const { next, result } = applyUpdate(before, input, { ...limits, by, ...(turnId ? { turnId } : {}), now: Date.now(), messages: app.messages })
      commit(before, next, result, by, 'update')
      return result
    }

    /* -------------------------------------------------------------- */
    /* Restored, synced from another tab, or a new conversation       */
    /* -------------------------------------------------------------- */

    seen = read()
    ctx.on('messages.changed', () => {
      if (conversation.threadId !== threadId) {
        threadId = conversation.threadId
        feedback = undefined
        lastRejected = []
        if (!persist) local = emptyState()
        const now = read()
        seen = now
        ctx.emit('conversation.state', { revision: now.revision, reason: now.revision === 0 ? 'reset' : 'restored', applied: 0, rejected: [] })
        publish()
        return
      }
      const now = read()
      if (now === seen) return
      // Same conversation: never go back to an older revision (an older tab or a stale save).
      if (now.revision < seen.revision) {
        write(seen)
        ctx.emit('error', { error: new Error(`[h4b] conversation-state: kept revision ${seen.revision} over an older one (${now.revision})`), source: SOURCE })
        return
      }
      seen = now
      ctx.emit('conversation.state', { revision: now.revision, reason: 'restored', applied: 0, rejected: [] })
      publish()
    })
    /* -------------------------------------------------------------- */
    /* Updates with the reply                                         */
    /* -------------------------------------------------------------- */

    let currentTurn: string | undefined
    const inTurn = new Map<string, unknown[]>()
    ctx.on('turn.status', ({ turnId, phase }) => {
      if (phase === 'received' || phase === 'acting') {
        currentTurn = turnId
        return
      }
      if (phase !== 'done' && phase !== 'error' && phase !== 'aborted') return
      if (currentTurn === turnId) currentTurn = undefined
      const queued = inTurn.get(turnId)
      inTurn.delete(turnId)
      for (const value of queued ?? []) update(value, 'backend', turnId)
      if (phase === 'done' && typeof updates === 'function') schedule(turnId)
    })

    if (updates === 'response') {
      ctx.on('stimulus', ({ turnId, stimulus }) => {
        if (stimulus.type !== 'ui.effect' || stimulus.name !== STATE_KEY) return
        // Applied when the turn ends: the reply is complete and its quotes can be checked.
        if (turnId) inTurn.set(turnId, [...(inTurn.get(turnId) ?? []), stimulus.value])
        else update(stimulus.value, 'backend')
      })
      if (options.action !== false) {
        ctx.registerAction({
          name: STATE_ACTION,
          description:
            'Updates the explicit state of this conversation (topic, goal, entities, decisions, facts with sources, pending items) with small changes. Record only what the messages support.',
          parameters: stateUpdateSchema(sections),
          confirm: 'never',
          exposeTo: ['assistant', 'agent'],
          handler: (args: unknown) => {
            const result = update(args, 'backend', currentTurn)
            return { revision: result.revision, applied: result.applied.map((c) => ({ section: c.section, id: c.id, change: c.before ? (c.after ? 'changed' : 'removed') : 'added' })), rejected: result.rejected }
          },
        })
      }
    }

    /* -------------------------------------------------------------- */
    /* Updates on a channel of their own                              */
    /* -------------------------------------------------------------- */

    let chain: Promise<void> = Promise.resolve()
    let controller = new AbortController()
    const schedule = (turnId: string) => {
      const updater = updates as StateUpdater
      running++
      publish()
      chain = chain
        .then(async () => {
          if (ctx.isDisposed) return
          const thread = conversation.threadId
          if (controller.signal.aborted) controller = new AbortController()
          const signal = controller.signal
          const state = read()
          const messages = app.messages.filter((m) => m.turnId === turnId)
          if (messages.length === 0) return
          let result: StateUpdate | undefined
          try {
            result = await updater({ state: viewOf(state, sections, feedback), messages, threadId: thread, turnId, signal })
          } catch (error) {
            if (!signal.aborted) ctx.emit('error', { error, source: SOURCE })
            return
          }
          if (!result || signal.aborted || ctx.isDisposed || conversation.threadId !== thread) return
          // Without a base, the update was computed from the state it was given.
          const withBase = typeof (result as { base?: unknown }).base === 'number' ? result : { ...result, base: state.revision }
          update(withBase, 'backend', turnId)
        })
        .finally(() => {
          running--
          publish()
        })
    }
    ctx.on('messages.changed', () => {
      if (conversation.threadId !== threadId) controller.abort()
    })

    /* -------------------------------------------------------------- */
    /* Sent with every request                                        */
    /* -------------------------------------------------------------- */

    if (options.send !== false) {
      ctx.intercept('request.before', async (request) => {
        if (running > 0) await Promise.race([chain, new Promise((resolve) => setTimeout(resolve, wait))])
        const view = viewOf(read(), sections, feedback)
        feedback = undefined
        const signal: Signal = {
          id: 'conversation-state',
          kind: 'context',
          key: STATE_KEY,
          modality: 'text',
          source: SOURCE,
          parts: [{ type: 'data', name: STATE_KEY, value: view }],
          timestamp: Date.now(),
        }
        return { ...request, context: [...request.context.filter((s) => s.key !== STATE_KEY), signal] }
      })
    }

    const control: ConversationStateControl = {
      sections,
      getState,
      subscribe(listener) {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      view: () => viewOf(read(), sections),
      update(input, opts = {}) {
        return update(input, opts.by ?? 'app', opts.turnId)
      },
      revert(revision, reason) {
        const before = read()
        const reverted = revertTo(before, revision, String(reason ?? ''), { ...limits, by: 'app', now: Date.now() })
        if ('error' in reverted) throw new Error(`[h4b] conversation-state: ${reverted.error}`)
        commit(before, reverted.next, reverted.result, 'app', 'revert')
        return reverted.result
      },
      history: () => read().journal,
      settled: () => chain,
    }
    ctx.provide('conversationState', control)
  },
}

/**
 * Explicit conversation state (ADR 0019): a small, structured and auditable
 * record of the conversation next to the raw history — active topic, goal,
 * depth, entities, decisions, facts with their sources and pending items.
 * Changed only by checked operations; sent with every request in a field of
 * its own (the context signal `conversation.state`).
 */
export const conversationState = definePlugin<ConversationStateOptions | undefined>(definition)

export type HttpStateUpdaterOptions = {
  /** Your endpoint: receives `{ state, messages, threadId, turnId }` and answers a `StateUpdate` (`{ base?, ops }`), or 204. */
  url: string
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  credentials?: RequestCredentials
  fetch?: typeof fetch
}

/** A `StateUpdater` that asks your backend (which calls a model with its own keys). */
export function httpStateUpdater(options: HttpStateUpdaterOptions): StateUpdater {
  return async ({ state, messages, threadId, turnId, signal }) => {
    const doFetch = options.fetch ?? globalThis.fetch
    const headers = typeof options.headers === 'function' ? await options.headers() : options.headers
    const response = await doFetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      credentials: options.credentials ?? 'same-origin',
      body: JSON.stringify({ state, messages, threadId, turnId }),
      signal,
    })
    if (response.status === 204) return undefined
    if (!response.ok) throw new Error(`[h4b] httpStateUpdater: ${response.status} from ${options.url}`)
    return (await response.json()) as StateUpdate
  }
}
