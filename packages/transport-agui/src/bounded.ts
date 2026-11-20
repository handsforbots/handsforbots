export const DEFAULT_MAX_EVENT_BYTES = 1_048_576
export const DEFAULT_MAX_RESPONSE_BYTES = 10_485_760

/** Longest SSE event separator (`\r\n\r\n`): a separator split across chunks spans at most this many characters. */
const MAX_SEP_LEN = 4

export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

export function isSSESizeLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('SSE event exceeds ')
}

const eventTooLarge = (maxEventBytes: number) => new Error(`SSE event exceeds ${maxEventBytes} bytes`)

export async function readBoundedText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  let overflow = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        overflow = true
        throw new Error(`Response body exceeds ${maxBytes} bytes`)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    if (overflow) await reader.cancel().catch(() => {})
    else reader.releaseLock()
  }
  return text
}

/** Index of the first event separator at or after `scanFrom`, or -1. Only reports a separator once it is unambiguous. */
export function findSSEBoundary(buffer: string, scanFrom: number): number {
  for (let i = Math.max(0, scanFrom); i < buffer.length; i++) {
    const c = buffer.charCodeAt(i)
    if (c === 13) {
      if (i + 3 < buffer.length && buffer.charCodeAt(i + 1) === 10 && buffer.charCodeAt(i + 2) === 13 && buffer.charCodeAt(i + 3) === 10) return i
      if (i + 1 < buffer.length && buffer.charCodeAt(i + 1) === 13) return i
    } else if (c === 10 && i + 1 < buffer.length && buffer.charCodeAt(i + 1) === 10) return i
  }
  return -1
}

function skipEventSeparator(buffer: string, boundary: number): number {
  return buffer.startsWith('\r\n\r\n', boundary) ? boundary + 4 : boundary + 2
}

/**
 * Pending text of the current (unterminated) event. Chunks are kept apart and
 * joined only when a separator arrives, and each chunk is scanned once (plus
 * the last few characters before it), so scanning stays linear in the input.
 */
export type SSEScanState = { parts: string[]; pendingBytes: number; tail: string; readonly buffer: string }

export function createSSEScanState(): SSEScanState {
  return {
    parts: [],
    pendingBytes: 0,
    tail: '',
    get buffer() {
      return this.parts.join('')
    },
  }
}

/** Appends a chunk and yields complete SSE blocks (without the separator). Throws when an event exceeds `maxEventBytes` UTF-8 bytes. */
export function* drainSSEBlocks(state: SSEScanState, chunk: string, maxEventBytes: number): Generator<string, void, void> {
  if (!chunk) return
  const window = state.tail + chunk
  const first = findSSEBoundary(window, 0)
  if (first < 0) {
    state.parts.push(chunk)
    state.pendingBytes += utf8ByteLength(chunk)
    state.tail = window.slice(-(MAX_SEP_LEN - 1))
    if (state.pendingBytes > maxEventBytes) throw eventTooLarge(maxEventBytes)
    return
  }
  state.parts.push(chunk)
  const full = state.parts.join('')
  state.parts = []
  state.pendingBytes = 0
  state.tail = ''
  let start = 0
  let boundary = full.length - window.length + first
  while (boundary >= 0) {
    const block = full.slice(start, boundary)
    if (utf8ByteLength(block) > maxEventBytes) throw eventTooLarge(maxEventBytes)
    start = skipEventSeparator(full, boundary)
    yield block
    boundary = findSSEBoundary(full, start)
  }
  const rest = full.slice(start)
  if (!rest) return
  state.parts = [rest]
  state.pendingBytes = utf8ByteLength(rest)
  state.tail = rest.slice(-(MAX_SEP_LEN - 1))
  if (state.pendingBytes > maxEventBytes) throw eventTooLarge(maxEventBytes)
}

export function assertResidualSSEWithinLimit(state: SSEScanState, maxEventBytes: number): void {
  if (state.pendingBytes > maxEventBytes) throw eventTooLarge(maxEventBytes)
}
