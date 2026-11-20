function randomHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = randomHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function secureRandom(): string {
  const cryptoRef = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoRef && 'randomUUID' in cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID()
  }
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
    return uuidFromBytes(cryptoRef.getRandomValues(new Uint8Array(16)))
  }
  throw new Error('[h4b] cryptographically secure random values are not available')
}

export function createId(prefix = ''): string {
  const random = secureRandom()
  return prefix ? `${prefix}_${random}` : random
}