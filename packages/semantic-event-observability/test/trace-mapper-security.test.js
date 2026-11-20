import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTraceMapper } from '../core/TraceMapper.js'
import Policy from '../core/Policy.js'
import { createObservability } from '../core/createObservability.js'
import { getPackageIdentity } from '../packageIdentity.js'

test('TraceMapper closes spans on turn.abandoned', () => {
	const spans = []
	const backend = {
		startSpan(name, attributes, parent) {
			const span = { name, attributes, parent, ended: false }
			spans.push(span)
			return span
		},
		endSpan(spanRef) {
			if (spanRef) spanRef.ended = true
		},
		setAttribute(spanRef, key, value) {
			if (spanRef?.attributes) spanRef.attributes[key] = value
		},
		setError() {},
	}

	const mapper = createTraceMapper({ backend })
	mapper.handleEvent({ type: 'turn.start', name: 'user.message', turnId: 't1' })
	mapper.handleEvent({ type: 'phase.start', phase: 'backend', turnId: 't1', source: 'bus' })
	mapper.handleEvent({ type: 'turn.abandoned', name: 'turn.abandoned', turnId: 't1', durationMs: 5 })

	assert.ok(spans.every((span) => span.ended))
	const root = spans.find((span) => span.name === 'turn:user.message')
	assert.equal(root?.attributes['turn.status'], 'abandoned')
})

test('TraceMapper expires open turns after TTL', () => {
	let clock = 0
	const spans = []
	const backend = {
		startSpan(name) {
			const span = { name, ended: false, attributes: {} }
			spans.push(span)
			return span
		},
		endSpan(spanRef) {
			if (spanRef) spanRef.ended = true
		},
		setAttribute(spanRef, key, value) {
			if (spanRef?.attributes) spanRef.attributes[key] = value
		},
		setError() {},
	}

	const mapper = createTraceMapper({
		backend,
		openTurnTtlMs: 100,
		now: () => clock,
	})

	mapper.handleEvent({ type: 'turn.start', name: 'user.message', turnId: 'stale' })
	clock = 200
	mapper.handleEvent({ type: 'turn.start', name: 'user.message', turnId: 'fresh' })

	const roots = spans.filter((span) => span.name === 'turn:user.message')
	assert.equal(roots.length, 2)
	assert.equal(roots.filter((span) => span.ended).length, 1)
	assert.equal(roots.filter((span) => !span.ended).length, 1)
	assert.equal(roots.find((span) => span.ended)?.attributes['turn.close_reason'], 'ttl_expired')
})

test('Policy does not rate-limit turn lifecycle events', () => {
	const policy = new Policy({ maxEventsPerMinute: 1, enabled: true })
	assert.equal(policy.shouldEmit('bus.trigger'), true)
	assert.equal(policy.shouldEmit('bus.trigger'), false)
	assert.equal(policy.shouldEmit('turn.end'), true)
	assert.equal(policy.shouldEmit('turn.abandoned'), true)
	assert.equal(policy.shouldEmit('phase.end'), true)
})

test('createObservability does not expose global API by default', async () => {
	const identity = getPackageIdentity()
	const key = identity.globalKey
	const previous = globalThis[key]
	delete globalThis[key]

	const observability = createObservability({ environment: 'test', exporters: [] })
	await observability.init()
	assert.equal(globalThis[key], undefined)

	observability.destroy()
	if (previous) globalThis[key] = previous
})

test('createObservability exposes global API when exposeGlobal is true', async () => {
	const identity = getPackageIdentity()
	const key = identity.globalKey

	const observability = createObservability({ environment: 'test', exporters: [], exposeGlobal: true })
	await observability.init()
	assert.equal(typeof globalThis[key]?.getTimeline, 'function')
	observability.destroy()
	assert.equal(globalThis[key], undefined)
})