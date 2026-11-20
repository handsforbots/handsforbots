import { isErrorEvent } from './isErrorEvent.js'
import { sevoAttributes } from './telemetryAttributes.js'
import { buildTurnRootSpan } from './turnSpanNaming.js'

const DEFAULT_OPEN_TURN_TTL_MS = 30 * 60_000
const DEFAULT_MAX_OPEN_TURNS = 512

/**
 * Maps semantic events to a hierarchical span tree via an injected span backend.
 * Backend-agnostic — OpenTelemetry adapter lives in exporters/otel.js.
 */
export function createTraceMapper(options = {}) {
	const isError = options.isError || isErrorEvent
	const backend = options.backend
	const onTurnContext = options.onTurnContext || null
	const turnRootSpan = options.turnRootSpan
	const openTurnTtlMs = options.openTurnTtlMs ?? DEFAULT_OPEN_TURN_TTL_MS
	const maxOpenTurns = options.maxOpenTurns ?? DEFAULT_MAX_OPEN_TURNS
	const now = typeof options.now === 'function' ? options.now : () => Date.now()
	if (!backend) {
		throw new Error('createTraceMapper requires a span backend')
	}

	/** @type {Map<string, TurnTraceState>} */
	const turns = new Map()

	return {
		handleEvent(event) {
			if (!event) return
			pruneOpenTurns()

			switch (event.type) {
				case 'turn.start':
					startTurn(event)
					break
				case 'turn.end':
					endTurn(event, 'completed')
					break
				case 'turn.abandoned':
					endTurn(event, 'abandoned')
					break
				case 'phase.start':
					startPhase(event)
					break
				case 'phase.end':
					endPhase(event)
					break
				case 'bus.trigger':
					if (event.turnId) recordBusEvent(event)
					else recordOrphanEvent(event)
					break
				default:
					break
			}
		},

		destroy() {
			for (const state of turns.values()) {
				for (const phaseRef of state.phaseSpans.values()) {
					try { backend.endSpan(phaseRef) } catch { /* noop */ }
				}
				try { backend.endSpan(state.rootSpan) } catch { /* noop */ }
			}
			turns.clear()
		},
	}

	function pruneOpenTurns() {
		const at = now()
		for (const [turnId, state] of turns) {
			if (at - state.startedAt > openTurnTtlMs) {
				forceCloseTurn(turnId, state, 'ttl_expired')
			}
		}
		while (turns.size > maxOpenTurns) {
			const oldest = turns.entries().next().value
			if (!oldest) break
			forceCloseTurn(oldest[0], oldest[1], 'map_cap')
		}
	}

	function forceCloseTurn(turnId, state, reason) {
		for (const phaseRef of state.phaseSpans.values()) {
			try { backend.endSpan(phaseRef) } catch { /* noop */ }
		}
		state.phaseSpans.clear()
		try {
			backend.setAttribute(state.rootSpan, 'turn.close_reason', reason)
			backend.endSpan(state.rootSpan)
		} catch { /* noop */ }
		turns.delete(turnId)
		onTurnContext?.(turnId, null)
	}

	function startTurn(event) {
		const root = buildTurnRootSpan(event, turnRootSpan)
		const rootSpan = backend.startSpan(root.name, root.attributes, undefined, { kind: root.kind })
		turns.set(event.turnId, {
			rootSpan,
			phaseSpans: new Map(),
			lastPhaseEndedAt: null,
			startedAt: now(),
		})
		onTurnContext?.(event.turnId, backend.getPropagationContext?.(rootSpan))
	}

	function endTurn(event, status) {
		const state = turns.get(event.turnId)
		if (!state) return

		for (const phaseRef of state.phaseSpans.values()) {
			try { backend.endSpan(phaseRef) } catch { /* noop */ }
		}
		state.phaseSpans.clear()

		if (event.durationMs != null) {
			backend.setAttribute(state.rootSpan, 'turn.duration_ms', event.durationMs)
		}

		if (state.lastPhaseEndedAt != null) {
			const renderMs = Math.max(0, now() - state.lastPhaseEndedAt)
			backend.setAttribute(state.rootSpan, 'phase.render_ms', renderMs)
		}

		if (status === 'abandoned') {
			backend.setAttribute(state.rootSpan, 'turn.status', 'abandoned')
		}

		backend.endSpan(state.rootSpan)
		turns.delete(event.turnId)
		onTurnContext?.(event.turnId, null)
	}

	function startPhase(event) {
		const state = turns.get(event.turnId)
		if (!state) return

		const phaseSpan = backend.startSpan(
			`phase:${event.phase}`,
			{
				...sevoAttributes(event),
				'phase.name': event.phase,
				'phase.source': event.source,
			},
			state.rootSpan,
		)
		state.phaseSpans.set(event.phase, phaseSpan)
	}

	function endPhase(event) {
		const state = turns.get(event.turnId)
		if (!state) return

		const phaseSpan = state.phaseSpans.get(event.phase)
		if (!phaseSpan) return

		if (event.durationMs != null) {
			backend.setAttribute(state.rootSpan, `phase.${event.phase}_ms`, event.durationMs)
		}

		backend.endSpan(phaseSpan)
		state.phaseSpans.delete(event.phase)
		state.lastPhaseEndedAt = now()
	}

	function recordBusEvent(event) {
		const state = turns.get(event.turnId)
		if (!state) {
			recordOrphanEvent(event)
			return
		}

		const eventSpan = backend.startSpan(
			`event:${event.name}`,
			{
				...sevoAttributes(event),
				'event.payload_preview': event.payloadSummary?.preview,
			},
			state.rootSpan,
		)
		backend.endSpan(eventSpan)
		maybeMarkError(event, state.rootSpan)
	}

	function recordOrphanEvent(event) {
		const eventSpan = backend.startSpan(
			`event:${event.name}`,
			{
				...sevoAttributes(event),
				'event.payload_preview': event.payloadSummary?.preview,
			},
		)
		backend.endSpan(eventSpan)
	}

	function maybeMarkError(event, rootSpan) {
		if (!isError(event)) return
		backend.setError(rootSpan, event.name)
		backend.setAttribute(rootSpan, 'turn.error_event', event.name)
		backend.setAttribute(rootSpan, 'error.type', event.name)
	}
}

/**
 * @typedef {object} TurnTraceState
 * @property {*} rootSpan
 * @property {Map<string, *>} phaseSpans
 * @property {number | null} lastPhaseEndedAt
 * @property {number} startedAt
 */