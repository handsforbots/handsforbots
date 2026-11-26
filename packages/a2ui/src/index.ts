import {
  basicCatalog,
  MessageProcessor,
  type ActionPayload,
  type Catalog,
  type ComponentApi,
  type ProcessableMessagePayload,
  type SurfaceModel,
} from '@a2ui/web_core/v1_0'
import {
  applyPatch,
  definePlugin,
  type JsonPatchOperation,
  type SurfacePartValue,
} from '@handsforbots/core'

export { basicCatalog, MessageProcessor, type ActionPayload, type Catalog, type ComponentApi, type ProcessableMessagePayload, type SurfaceModel }

export type A2UIOptions = {
  /** A2UI catalogs accepted by the processor. Defaults to `[basicCatalog]`. */
  catalogs?: Catalog<any>[]
  /**
   * H4B action names that surface interactions may execute locally (`origin: 'agent'`).
   * Any surface action not in this list is sent to the backend as a `gui-event` trigger signal.
   */
  allowActions?: string[]
  /** Send active surface data models (`sendDataModel: true`) as context signal `a2ui.dataModel`. Default `true`. */
  reportDataModel?: boolean
  /** Send A2UI 1.0 renderer capabilities as context signal `a2ui.capabilities`. Default `false`. */
  reportCapabilities?: boolean
}

export type A2UISurfaceEntry = {
  surfaceId: string
  model: SurfaceModel<ComponentApi>
  slot?: string
  messageId?: string
}

export type A2UIState = {
  surfaces: ReadonlyMap<string, A2UISurfaceEntry>
}

export type A2UIActionInput = {
  name: string
  surfaceId: string
  sourceComponentId: string
  context: Record<string, unknown>
  catalogId?: string
  userMessage?: string
  timestamp?: string
}

export type A2UIService = {
  /** Underlying `@a2ui/web_core` processor for any host renderer (React, Lit, Angular, Vue, custom). */
  readonly processor: MessageProcessor<ComponentApi>
  getState(): A2UIState
  getSurface(surfaceId: string): A2UISurfaceEntry | undefined
  subscribe(listener: () => void): () => void
  /** Feeds raw A2UI 1.0 messages or operations into the processor. */
  process(messages: ProcessableMessagePayload): void
  /**
   * Handles a user interaction from the host renderer: runs an allowlisted H4B action
   * (`origin: 'agent'`) or sends a `gui-event` trigger signal to the backend.
   */
  dispatchAction(action: A2UIActionInput): Promise<void>
  /** Removes an active surface from the processor. */
  deleteSurface(surfaceId: string): void
}

declare module '@handsforbots/core' {
  interface Services {
    a2ui: A2UIService
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Extracts A2UI messages/operations from a `ui.surface` payload (AG-UI activity wrapper or direct messages). */
function extractMessages(payload: unknown): ProcessableMessagePayload | undefined {
  if (!payload) return undefined
  if (Array.isArray(payload)) return payload as ProcessableMessagePayload
  if (!isRecord(payload)) return undefined
  if (isRecord(payload.content)) {
    const content = payload.content
    if (Array.isArray(content.operations)) return content.operations as ProcessableMessagePayload
    if (Array.isArray(content.messages)) return content.messages as ProcessableMessagePayload
  }
  if (Array.isArray(payload.operations)) return payload.operations as ProcessableMessagePayload
  if (Array.isArray(payload.messages)) return payload.messages as ProcessableMessagePayload
  if (
    'createSurface' in payload ||
    'updateComponents' in payload ||
    'updateDataModel' in payload ||
    'deleteSurface' in payload
  ) {
    return payload as ProcessableMessagePayload
  }
  return undefined
}

/**
 * Headless A2UI 1.0 host plugin. Maintains surface models over `@a2ui/web_core`,
 * bridges `ui.surface` (`kind: 'a2ui'`) stimuli into the processor, and routes
 * surface actions to allowlisted H4B actions or `gui-event` signals.
 * Presentation is left entirely to the host app.
 */
export const a2ui = definePlugin<A2UIOptions | undefined>({
  name: 'a2ui',
  provides: ['a2ui'],
  apply(ctx, options = {}) {
    const catalogs = options.catalogs?.length ? options.catalogs : [basicCatalog]
    const allowed = new Set(options.allowActions ?? [])
    const reportDataModel = options.reportDataModel !== false
    const reportCapabilities = options.reportCapabilities === true

    const listeners = new Set<() => void>()
    const meta = new Map<string, { slot?: string; messageId?: string }>()
    /** Raw AG-UI activity content per surfaceId, kept so `ACTIVITY_DELTA` JSON Patches can be applied. */
    const rawActivityContent = new Map<string, Record<string, unknown>>()
    let pendingMeta: { slot?: string; messageId?: string } | undefined

    const notify = () => {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          ctx.app.emit('error', { error, source: 'a2ui' })
        }
      }
    }

    const handleAction = async (action: ActionPayload) => {
      if (allowed.has(action.name)) {
        await ctx.app.runAction(action.name, action.context, { origin: 'agent' })
        return
      }
      const parts: ({ type: 'text'; text: string } | { type: 'data'; name: string; value: unknown })[] = []
      if (typeof action.userMessage === 'string' && action.userMessage.trim()) {
        parts.push({ type: 'text', text: action.userMessage })
      }
      parts.push({ type: 'data', name: 'a2ui.action', value: action })
      ctx.app.signal({
        kind: 'trigger',
        modality: 'gui-event',
        source: 'a2ui',
        parts,
      })
    }

    const processor = new MessageProcessor<ComponentApi>(catalogs, (action) => {
      void handleAction(action).catch((error) => ctx.app.emit('error', { error, source: 'a2ui' }))
    }, {
      version: '1.0',
      reportErrorsOnly: true,
      errorHandler: (error) => ctx.app.emit('error', { error, source: 'a2ui' }),
    })

    const subCreated = processor.onSurfaceCreated((surface) => {
      if (pendingMeta) meta.set(surface.id, { ...pendingMeta })
      notify()
    })
    const subDeleted = processor.onSurfaceDeleted((id) => {
      meta.delete(id)
      rawActivityContent.delete(id)
      notify()
    })

    const process = (messages: ProcessableMessagePayload, info?: { slot?: string; messageId?: string }) => {
      const prev = pendingMeta
      pendingMeta = info
      try {
        processor.processMessages(messages)
        if (info) {
          for (const id of processor.getSurfaces().keys()) {
            if (!meta.has(id)) meta.set(id, { ...info })
          }
        }
      } catch (error) {
        ctx.app.emit('error', { error, source: 'a2ui' })
      } finally {
        pendingMeta = prev
      }
      notify()
    }

    const applySurface = (
      surface: { surfaceId?: string; op?: string; payload?: unknown; slot?: string; messageId?: string },
    ) => {
      const op = surface.op ?? 'snapshot'
      const info = {
        ...(surface.slot !== undefined ? { slot: surface.slot } : {}),
        ...(surface.messageId !== undefined ? { messageId: surface.messageId } : {}),
      }

      if (op === 'delete') {
        if (surface.surfaceId) processor.model.deleteSurface(surface.surfaceId)
        return
      }

      if (op === 'delta') {
        if (surface.surfaceId && isRecord(surface.payload) && Array.isArray(surface.payload.patch)) {
          const base = rawActivityContent.get(surface.surfaceId)
          if (base) {
            try {
              const patched = applyPatch(base, surface.payload.patch as JsonPatchOperation[])
              if (isRecord(patched)) {
                rawActivityContent.set(surface.surfaceId, patched)
                const rawMessages = extractMessages({ content: patched })
                if (rawMessages) {
                  const filtered = Array.isArray(rawMessages)
                    ? rawMessages.filter((m) => {
                        if (!isRecord(m) || !isRecord(m.createSurface)) return true
                        const id = m.createSurface.surfaceId
                        return typeof id !== 'string' || !processor.getSurfaces().has(id)
                      })
                    : rawMessages
                  process(filtered as ProcessableMessagePayload, info)
                }
              }
            } catch (error) {
              ctx.app.emit('error', { error, source: 'a2ui' })
            }
          }
          return
        }
        const messages = extractMessages(surface.payload)
        if (messages) process(messages, info)
        return
      }

      // snapshot
      if (surface.surfaceId && isRecord(surface.payload) && isRecord(surface.payload.content)) {
        rawActivityContent.set(surface.surfaceId, structuredClone(surface.payload.content))
      }
      const messages = extractMessages(surface.payload)
      if (messages) process(messages, info)
    }

    const buildEntries = (): ReadonlyMap<string, A2UISurfaceEntry> => {
      const entries = new Map<string, A2UISurfaceEntry>()
      for (const [surfaceId, model] of processor.getSurfaces()) {
        const info = meta.get(surfaceId)
        entries.set(surfaceId, {
          surfaceId,
          model,
          ...(info?.slot !== undefined ? { slot: info.slot } : {}),
          ...(info?.messageId !== undefined ? { messageId: info.messageId } : {}),
        })
      }
      return entries
    }

    const clearAll = () => {
      for (const id of [...processor.getSurfaces().keys()]) {
        processor.model.deleteSurface(id)
      }
      meta.clear()
      rawActivityContent.clear()
      notify()
    }

    // Rehydrate A2UI surfaces already present in restored conversation history.
    for (const message of ctx.app.messages) {
      if (message.role !== 'assistant') continue
      for (const part of message.parts) {
        if (part.type !== 'data' || part.name !== 'surface') continue
        const value = part.value as SurfacePartValue | undefined
        if (value?.kind !== 'a2ui') continue
        applySurface({ surfaceId: value.surfaceId, op: 'snapshot', payload: value.payload, messageId: message.id })
      }
    }

    let lastThreadId = ctx.app.conversation.threadId

    ctx.on('stimulus', ({ stimulus }) => {
      if (stimulus.type !== 'ui.surface' || stimulus.kind !== 'a2ui') return
      applySurface(stimulus)
    })

    ctx.on('messages.changed', () => {
      if (ctx.app.conversation.threadId !== lastThreadId) {
        lastThreadId = ctx.app.conversation.threadId
        clearAll()
      }
    })

    ctx.intercept('request.before', (request) => {
      const extra = [...request.context]
      if (reportDataModel) {
        try {
          const dataModel = processor.getRendererDataModel('1.0')
          if (dataModel && Object.keys(dataModel).length > 0) {
            extra.push({
              id: 'a2ui-data-model',
              kind: 'context',
              key: 'a2ui.dataModel',
              modality: 'gui-event',
              source: 'a2ui',
              parts: [{ type: 'data', name: 'a2ui.dataModel', value: dataModel }],
              timestamp: Date.now(),
            })
          }
        } catch (error) {
          ctx.app.emit('error', { error, source: 'a2ui' })
        }
      }
      if (reportCapabilities) {
        try {
          const capabilities = processor.getRendererCapabilities({ versions: ['1.0'] })
          extra.push({
            id: 'a2ui-capabilities',
            kind: 'context',
            key: 'a2ui.capabilities',
            modality: 'gui-event',
            source: 'a2ui',
            parts: [{ type: 'data', name: 'a2ui.capabilities', value: capabilities }],
            timestamp: Date.now(),
          })
        } catch (error) {
          ctx.app.emit('error', { error, source: 'a2ui' })
        }
      }
      return extra.length === request.context.length ? request : { ...request, context: extra }
    })

    const service: A2UIService = {
      processor,
      getState: () => ({ surfaces: buildEntries() }),
      getSurface: (surfaceId) => buildEntries().get(surfaceId),
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      process: (messages) => process(messages),
      dispatchAction: (action) =>
        handleAction({
          ...action,
          timestamp: action.timestamp ?? new Date().toISOString(),
        }),
      deleteSurface: (surfaceId) => processor.model.deleteSurface(surfaceId),
    }

    ctx.provide('a2ui', service)

    ctx.effect(() => () => {
      subCreated.unsubscribe()
      subDeleted.unsubscribe()
      listeners.clear()
      meta.clear()
      rawActivityContent.clear()
      processor.dispose()
    })
  },
})
