import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTraceContextBridge } from '../core/TraceContextBridge.js'

test('withTraceContext skips trace headers for cross-origin URLs by default', () => {
	const bridge = createTraceContextBridge({
		getContext: () => ({ traceId: 'trace-1' }),
	})

	globalThis.location = { href: 'https://app.example/', origin: 'https://app.example' }

	const same = bridge.withTraceContext('https://app.example/api', { headers: {} })
	assert.equal(same.headers['sevo-trace-id'], 'trace-1')

	const cross = bridge.withTraceContext('https://other.example/api', { headers: {} })
	assert.equal(cross.headers?.['sevo-trace-id'], undefined)
	delete globalThis.location
})

test('propagateTo allowlist limits header injection', () => {
	const bridge = createTraceContextBridge({
		getContext: () => ({ traceId: 'trace-2' }),
		propagateTo: ['https://api.example'],
	})

	const allowed = bridge.withTraceContext('https://api.example/v1', { headers: {} })
	assert.equal(allowed.headers['sevo-trace-id'], 'trace-2')

	const denied = bridge.withTraceContext('https://evil.example/v1', { headers: {} })
	assert.equal(denied.headers?.['sevo-trace-id'], undefined)

	for (const lookalike of ['https://api.example.evil.test/v1', 'https://api.example@evil.test/', 'http://api.example/v1', 'https://api.example:8443/v1']) {
		assert.equal(bridge.withTraceContext(lookalike, { headers: {} }).headers?.['sevo-trace-id'], undefined, lookalike)
	}
})

test('propagateTo string rules with a path match only that path', () => {
	const bridge = createTraceContextBridge({
		getContext: () => ({ traceId: 'trace-3' }),
		propagateTo: ['https://api.example/v1'],
	})
	assert.equal(bridge.withTraceContext('https://api.example/v1/turn', { headers: {} }).headers['sevo-trace-id'], 'trace-3')
	assert.equal(bridge.withTraceContext('https://api.example/v10', { headers: {} }).headers?.['sevo-trace-id'], undefined)
})