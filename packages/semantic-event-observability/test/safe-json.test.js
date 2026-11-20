import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrubSensitiveString, summarizePayload } from '../utils/safeJson.js'

test('scrubSensitiveString redacts tokens, emails, and digit runs', () => {
	assert.match(scrubSensitiveString('?token=sk_live_ABC'), /\[redacted/)
	assert.match(scrubSensitiveString('Bearer eyJhbGciOi'), /\[redacted/)
	assert.match(scrubSensitiveString('contact me@host.example'), /\[redacted-email]/)
	assert.match(scrubSensitiveString('DE89370400440532013000'), /\[redacted-iban]/)
	assert.equal(scrubSensitiveString('https://x.test/reset?id=1&token=abc#top'), 'https://x.test/reset?id=1&token=[redacted]#top')
})

test('scrubSensitiveString keeps ids and short numbers', () => {
	for (const id of ['msg_123e4567-e89b-12d3-a456-426614174000', 'turn 42 took 1234 ms', '2026-11-19T21:40:00Z']) {
		assert.equal(scrubSensitiveString(id), id)
	}
})

test('summarizePayload scrubs sensitive values in previews', () => {
	const summary = summarizePayload({ note: 'my SSN is 123-45-6789' })
	assert.doesNotMatch(summary.preview, /123-45-6789/)
})