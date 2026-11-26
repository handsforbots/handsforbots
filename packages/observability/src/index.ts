import { definePlugin, type Exposure, type H4B, type Route, type Signal } from '@handsforbots/core'
import {
  createObservability,
  type CreateObservabilityOptions,
  type Observability,
} from '@handsforbots/semantic-event-observability'
import {
  sanitizeCuePayload,
  sanitizeDecisionPayload,
  sanitizeErrorValue,
  sanitizeSpeechPayload,
  sanitizeTtsPayload,
  sanitizeTurnError,
} from './redact.js'

export type ObservabilityOptions = CreateObservabilityOptions & {
  /** Record message text and action arguments. Default false (privacy). */
  includeContent?: boolean
  /** Record navigator userAgent and language as `client.environment`. Default false. */
  clientEnvironment?: boolean
}

declare module '@handsforbots/core' {
  interface Services {
    observability: Observability
  }
}

const ROUTES: Route[] = ['transport', 'direct', 'capture', 'agent', 'push']

/** Counters for experiments (ADR 0017), labelled with the conversation's attributes. */
export const H4B_EXPOSED_COUNTER = 'h4b_experiment_exposed_total'
export const H4B_ENGAGED_COUNTER = 'h4b_conversation_engaged_total'

/**
 * What was already counted, per app: survives the plugin being unmounted and
 * mounted again (consent revoked and granted), so nothing is counted twice.
 */
const counted = new WeakMap<H4B, { exposures: WeakSet<Exposure>; engaged: Set<string> }>()

/** The visitor started this turn (typed, spoke, sent a file, clicked a suggestion), not an idle nudge or a sensor. */
export function isVisitorTurn(signal: Signal | undefined): boolean {
  return !!signal && signal.kind === 'trigger' && signal.modality !== 'sensor' && signal.meta?.reason !== 'idle'
}

/** Turn and phase model of the v2 kernel: one turn per trigger, one phase per route. */
export const H4B_TURN_START_EVENTS = ['turn.started']
export const H4B_TURN_END_EVENTS = ['turn.done', 'turn.error', 'turn.aborted']
export const H4B_PHASES = ROUTES.map((route) => ({
  id: route,
  startEvent: `route.${route}.start`,
  endEvent: `route.${route}.end`,
}))

export const observability = definePlugin<ObservabilityOptions | undefined>({
  name: 'observability',
  provides: ['observability'],
  apply(ctx, options = {}) {
    const { includeContent = false, clientEnvironment = false, ...config } = options
    const obs = createObservability({
      environment: 'production',
      exporters: ['memory'],
      turnStartEvents: H4B_TURN_START_EVENTS,
      turnEndEvents: H4B_TURN_END_EVENTS,
      phases: H4B_PHASES,
      ...config,
    })
    ctx.provide('observability', obs)
    void obs.init().catch((error) => ctx.emit('error', { error, source: 'observability' }))
    const trigger = attach(ctx.app, obs, includeContent, clientEnvironment, ctx.on.bind(ctx))
    const experiments = trackExperiments(ctx.app, obs, ctx.on.bind(ctx), trigger.record)
    ctx.onDispose(() => {
      experiments.dispose()
      trigger.dispose()
      obs.endSession('dispose')
      obs.destroy()
    })
  },
})

/** Feeds kernel events into the observability pipeline through a minimal instrumented bus. */
function attach(
  h4b: H4B,
  obs: Observability,
  includeContent: boolean,
  clientEnvironment: boolean,
  on: H4B['on'],
): { dispose(): void; record: (name: string, payload?: Record<string, unknown>) => void } {
  const bus = { on: () => {}, trigger: (_name: string, _args?: unknown): unknown => undefined }
  obs.instrument(bus, {
    stateProvider: () => ({ busy: h4b.busy, contextSignals: h4b.context.length, messages: h4b.messages.length }),
  })
  const record = (name: string, payload: Record<string, unknown> = {}) => bus.trigger(name, [payload])
  const openTurns = new Map<string, Route | undefined>()
  // Perceived latency: from the user's input to the first thing they can see, per route.
  const timing = new Map<string, { start: number; route?: Route; firstSeen?: boolean }>()
  const offs: (() => void)[] = []
  const VISIBLE = new Set(['message.delta', 'message.part', 'ui.surface', 'ui.effect', 'action.call', 'action.result', 'audio'])

  if (clientEnvironment) {
    const nav = (globalThis as { navigator?: { userAgent?: string; language?: string } }).navigator
    if (nav?.userAgent) record('client.environment', { userAgent: nav.userAgent, language: nav.language })
  }

  offs.push(
    on('turn.status', (status) => {
      const labels = { turnId: status.turnId, route: status.route ?? 'pending' }
      if (!timing.has(status.turnId)) timing.set(status.turnId, { start: status.signal?.timestamp ?? status.at })
      if (status.route) timing.get(status.turnId)!.route = status.route
      if (!openTurns.has(status.turnId)) {
        openTurns.set(status.turnId, undefined)
        record('turn.started', { ...labels, modality: status.signal?.modality, source: status.signal?.source })
      }
      if (status.phase === 'acting' && status.route && !openTurns.get(status.turnId)) {
        openTurns.set(status.turnId, status.route)
        record(`route.${status.route}.start`, labels)
      }
      if (status.phase === 'done' || status.phase === 'error' || status.phase === 'aborted') {
        const route = openTurns.get(status.turnId)
        if (route) record(`route.${route}.end`, labels)
        openTurns.delete(status.turnId)
        record(`turn.${status.phase}`, {
          ...labels,
          ...(status.error ? { error: includeContent ? status.error : sanitizeTurnError(status.error) } : {}),
        })
        const t = timing.get(status.turnId)
        timing.delete(status.turnId)
        if (t) obs.recordMetric('h4b_turn_duration_ms', status.at - t.start, { route: status.route ?? 'none', phase: status.phase })
      }
    }),
    on('signal', (signal) =>
      record(`signal.${signal.modality}`, {
        kind: signal.kind,
        source: signal.source,
        ...(includeContent ? { parts: signal.parts.map((p) => (p.type === 'text' ? p.text : p.type)) } : {}),
      }),
    ),
    on('action.invoked', (event) =>
      record(event.error ? 'action.failed' : 'action.invoked', {
        action: event.name,
        origin: event.origin,
        ...(event.error ? { error: includeContent ? event.error : sanitizeTurnError(event.error) } : {}),
      }),
    ),
    on('stimulus', ({ turnId, stimulus }) => {
      const t = timing.get(turnId)
      if (t && !t.firstSeen && VISIBLE.has(stimulus.type)) {
        t.firstSeen = true
        const ms = Date.now() - t.start
        obs.recordMetric('h4b_first_response_ms', ms, { route: t.route ?? 'none' })
        record('turn.first_response', { turnId, route: t.route ?? 'none', ms })
      }
      // Token deltas are too chatty; everything else is a meaningful event.
      if (stimulus.type === 'message.delta' || stimulus.type === 'message.start') return
      record(`stimulus.${stimulus.type}`, {
        turnId,
        ...('name' in stimulus && typeof stimulus.name === 'string' ? { name: stimulus.name } : {}),
        ...(stimulus.type === 'error' && includeContent ? { error: stimulus.message } : {}),
      })
    }),
    on('error', ({ error, source }) => {
      if (includeContent) {
        const { code, stage } = (error ?? {}) as { code?: unknown; stage?: unknown }
        record('kernel.error', {
          source,
          error: (error as Error)?.message ?? String(error),
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof stage === 'string' ? { stage } : {}),
        })
      } else {
        record('kernel.error', { source, ...sanitizeErrorValue(error) })
      }
    }),
  )
  // Plugin events, recorded when those plugins are installed (no dependency on them).
  const onPlugin = on as unknown as (event: string, listener: (payload: Record<string, unknown>) => void) => () => void
  offs.push(
    onPlugin('voice.speech', (payload) => {
      const phase = String(payload.phase)
      const body = includeContent ? payload : sanitizeSpeechPayload(payload)
      record(`voice.speech.${phase}`, body)
    }),
    onPlugin('voice.tts', (payload) => {
      const event = String(payload.event)
      const body = includeContent ? payload : sanitizeTtsPayload(payload)
      record(`voice.tts.${event}`, body)
    }),
    onPlugin('cue.changed', (cue) => record('cue.changed', includeContent ? cue : sanitizeCuePayload(cue))),
    onPlugin('cue.repeat', (cue) => record('cue.repeat', includeContent ? cue : sanitizeCuePayload(cue))),
    // Noise check: the report's numbers and verdict (no audio), and what the voice did.
    onPlugin('voice.noise', ({ report, action }) => {
      const r = (report ?? {}) as Record<string, unknown>
      record('voice.noise', {
        verdict: r.verdict,
        reasons: r.reasons,
        noiseFloorDb: r.noiseFloorDb,
        peakDb: r.peakDb,
        ...(r.snrDb === undefined ? {} : { snrDb: r.snrDb }),
        fluctuationDb: r.fluctuationDb,
        clippingRatio: r.clippingRatio,
        durationMs: r.durationMs,
        ...(action ? { action } : {}),
      })
    }),
    // Level gate: `voice.level.monitor.open`, `voice.level.learned` (levels in dBFS), `voice.level.learn.skipped`.
    onPlugin('voice.level', ({ event, ...rest }) => record(`voice.level.${String(event)}`, rest)),
    onPlugin('voice.decision', (decision) => {
      record('voice.decision', includeContent ? decision : sanitizeDecisionPayload(decision))
    }),
  )
  return { dispose: () => offs.forEach((off) => off()), record }
}

/**
 * Conversation attributes on every span and in `baggage`; exposures (also the
 * ones from before this plugin mounted, e.g. before `analytics` was granted)
 * and the conversation's first visitor turn as events and counters.
 */
function trackExperiments(
  h4b: H4B,
  obs: Observability,
  on: H4B['on'],
  record: (name: string, payload?: Record<string, unknown>) => void,
): { dispose(): void } {
  let state = counted.get(h4b)
  if (!state) counted.set(h4b, (state = { exposures: new WeakSet(), engaged: new Set() }))
  const done = state

  obs.setAttributes(h4b.conversation.attributes)

  const expose = (exposure: Exposure, late: boolean) => {
    if (done.exposures.has(exposure)) return
    done.exposures.add(exposure)
    record('experiment.exposed', { experiment: exposure.experiment, ...exposure.attributes, ...(late ? { late: true } : {}) })
    obs.recordCounter(H4B_EXPOSED_COUNTER, 1, { experiment: exposure.experiment, ...exposure.attributes })
  }
  const engage = () => {
    const threadId = h4b.conversation.threadId
    if (done.engaged.has(threadId)) return
    done.engaged.add(threadId)
    obs.recordCounter(H4B_ENGAGED_COUNTER, 1, { ...h4b.conversation.attributes })
  }

  // Granted after the draw: what the visitor saw in this conversation still counts.
  for (const exposure of h4b.exposures) expose(exposure, true)
  if (h4b.exposures.length > 0 && h4b.messages.some((m) => m.role === 'user')) engage()

  const seen = new Set<string>()
  const offs = [
    on('conversation.attributes', ({ attributes }) => obs.setAttributes(attributes)),
    on('experiment.exposed', (exposure) => expose(exposure, false)),
    on('turn.status', (status) => {
      if (seen.has(status.turnId)) {
        if (status.phase === 'done' || status.phase === 'error' || status.phase === 'aborted') seen.delete(status.turnId)
        return
      }
      seen.add(status.turnId)
      if (!isVisitorTurn(status.signal)) return
      // A restored conversation the visitor already wrote in was counted on an earlier page.
      const before = h4b.messages.some(
        (m) => m.role === 'user' && m.turnId !== status.turnId && m.modality !== 'gui-event' && m.modality !== 'sensor',
      )
      if (before) done.engaged.add(h4b.conversation.threadId)
      else engage()
    }),
  ]
  return { dispose: () => offs.forEach((off) => off()) }
}
