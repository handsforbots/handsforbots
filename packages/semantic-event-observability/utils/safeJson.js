const DEFAULT_DENYLIST = [
	'password',
	'token',
	'apiKey',
	'api_key',
	'authorization',
	'secret',
	'cryptoKey',
	'history',
	'payload',
]

/**
 * Safely stringify values for logs and exporters.
 */
export function safeJson(value, maxBytes = 2048) {
	try {
		const text = JSON.stringify(value, replacer)
		if (text.length <= maxBytes) return text
		return `${text.slice(0, maxBytes)}…[+${text.length - maxBytes} bytes]`
	} catch {
		return '[unserializable]'
	}
}

// Digit runs stand alone (not inside ids such as UUIDs); IBANs start with a country code.
export function scrubSensitiveString(text) {
	if (typeof text !== 'string') return text
	return text
		.replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+/g, '[redacted-token]')
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
		.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[redacted-iban]')
		.replace(/(?<![\w-])\d(?:[ -]?\d){8,}(?![\w-])/g, '[redacted-digits]')
		.replace(/([?&](?:token|access_token|key|api_key|code|password)=)[^\s&#]+/gi, '$1[redacted]')
}

function replacer(key, value) {
	if (typeof value === 'function') return '[Function]'
	if (value instanceof Error) {
		return {
			name: value.name,
			message: scrubSensitiveString(value.message),
		}
	}
	if (typeof value === 'string') return scrubSensitiveString(value)
	return value
}

/**
 * Build a redacted summary object safe for telemetry.
 */
export function summarizePayload(value, options = {}) {
	const denylist = options.denylist || DEFAULT_DENYLIST
	const maxBytes = options.maxPayloadBytes || 2048
	const maxDepth = options.maxDepth ?? 3

	const summary = summarizeValue(value, denylist, maxDepth, 0)
	return {
		preview: safeJson(summary, maxBytes),
		kind: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
		size: Array.isArray(value) ? value.length : undefined,
	}
}

function summarizeValue(value, denylist, maxDepth, depth) {
	if (value == null) return value
	if (depth >= maxDepth) return `[${typeof value}]`

	if (Array.isArray(value)) {
		return value.slice(0, 5).map((item) => summarizeValue(item, denylist, maxDepth, depth + 1))
	}

	if (typeof value !== 'object') {
		if (typeof value === 'string') {
			const scrubbed = scrubSensitiveString(value)
			if (scrubbed.length > 200) return `${scrubbed.slice(0, 200)}…`
			return scrubbed
		}
		return value
	}

	const output = {}
	for (const [key, nested] of Object.entries(value)) {
		if (denylist.some((field) => key.toLowerCase().includes(field.toLowerCase()))) {
			output[key] = '[redacted]'
			continue
		}
		output[key] = summarizeValue(nested, denylist, maxDepth, depth + 1)
	}
	return output
}

export { DEFAULT_DENYLIST }
