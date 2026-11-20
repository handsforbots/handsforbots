export const DEFAULT_MAX_RESPONSE_BYTES = 10_485_760

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