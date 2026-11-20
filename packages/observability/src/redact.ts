const SPEECH_FIELDS = new Set([
  'phase',
  'provider',
  'chars',
  'ms',
  'interrupted',
  'reason',
  'code',
  'messageId',
  'from',
  'to',
])

const TTS_FIELDS = new Set([
  'provider',
  'event',
  'worker',
  'attempt',
  'ms',
  'loaded',
  'total',
  'size',
  'policy',
  'action',
  'to',
  'state',
  'reason',
])

const CUE_FIELDS = new Set(['channel', 'value', 'streak', 'count', 'level', 'from', 'replaced', 'messageId'])

export function pickFields(payload: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    if (Object.hasOwn(payload, key)) out[key] = payload[key]
  }
  return out
}

export function sanitizeSpeechPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return pickFields(payload, SPEECH_FIELDS)
}

export function sanitizeTtsPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return pickFields(payload, TTS_FIELDS)
}

export function sanitizeCuePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return pickFields(payload, CUE_FIELDS)
}

// Error names, codes and stages are identifiers; anything else may be free text.
const identifier = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z][\w.:-]{0,63}$/.test(value) ? value : undefined

/** Safe error shape for telemetry when message text and stacks must stay out. */
export function sanitizeErrorValue(error: unknown): Record<string, unknown> {
  if (error == null) return {}
  if (typeof error !== 'object') return { name: typeof error }
  const e = error as { name?: unknown; code?: unknown; stage?: unknown }
  const out: Record<string, unknown> = { name: identifier(e.name) ?? 'Error' }
  const code = identifier(e.code)
  const stage = identifier(e.stage)
  if (code) out.code = code
  if (stage) out.stage = stage
  return out
}

export function sanitizeTurnError(error: unknown): Record<string, unknown> {
  return sanitizeErrorValue(error)
}