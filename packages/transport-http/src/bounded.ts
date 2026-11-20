export const DEFAULT_MAX_EVENT_BYTES = 1_048_576
export const DEFAULT_MAX_RESPONSE_BYTES = 10_485_760

export async function readBoundedText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) throw new Error(`Response body exceeds ${maxBytes} bytes`)
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return text
}

const EVENT_BOUNDARY = /\r?\n\r?\n/g

export function findSSEBoundary(buffer: string, scanFrom: number): number {
  EVENT_BOUNDARY.lastIndex = scanFrom
  const match = EVENT_BOUNDARY.exec(buffer)
  return match ? match.index : -1
}

function skipEventSeparator(buffer: string, boundary: number): number {
  const tail = buffer.slice(boundary)
  const match = /^\r?\n\r?\n/.exec(tail)
  return boundary + (match ? match[0].length : 0)
}

export type SSEScanState = { buffer: string; scanFrom: number }

export function createSSEScanState(): SSEScanState {
  return { buffer: '', scanFrom: 0 }
}

/** Appends a chunk and yields complete SSE blocks (without trailing separator). */
export function* drainSSEBlocks(state: SSEScanState, chunk: string, maxEventBytes: number): Generator<string, void, void> {
  state.buffer += chunk
  let start = 0
  let searchFrom = state.scanFrom
  while (true) {
    const boundary = findSSEBoundary(state.buffer, searchFrom)
    if (boundary < 0) {
      if (state.buffer.length - start > maxEventBytes) throw new Error(`SSE event exceeds ${maxEventBytes} bytes`)
      state.buffer = state.buffer.slice(start)
      state.scanFrom = Math.max(0, state.buffer.length - 3)
      return
    }
    const block = state.buffer.slice(start, boundary)
    if (block.length > maxEventBytes) throw new Error(`SSE event exceeds ${maxEventBytes} bytes`)
    start = skipEventSeparator(state.buffer, boundary)
    searchFrom = start
    yield block
  }
}

export function assertResidualSSEWithinLimit(state: SSEScanState, maxEventBytes: number): void {
  if (state.buffer.length > maxEventBytes) throw new Error(`SSE event exceeds ${maxEventBytes} bytes`)
}