/** Exact localhost / loopback checks (no `localhost.evil.com`). */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) return false
  return match.slice(1).every((part) => {
    const n = Number(part)
    return Number.isInteger(n) && n >= 0 && n <= 255
  })
}

export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/

export function normalizeSessionId(value: string): string | undefined {
  const id = value.trim()
  return SESSION_ID_PATTERN.test(id) ? id : undefined
}