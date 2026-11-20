/** Allowed MCP CSP source: `https://host[:port]` or `https://*.host` (lowercase DNS labels only). */
const CSP_DOMAIN =
  /^https:\/\/(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/

export function isValidCspDomain(domain: string): boolean {
  if (/\s/.test(domain)) return false
  const d = domain.trim()
  if (!d || /[;,'"<>]/.test(d)) return false
  const m = CSP_DOMAIN.exec(d)
  if (!m) return false
  const port = m[3]
  if (port !== undefined) {
    const n = Number(port)
    if (n < 1 || n > 65535) return false
  }
  return true
}

/** Drops domains that are not safe `https://` host entries for CSP. */
export function filterCspDomains(domains: string[] | undefined): string[] {
  if (!domains?.length) return []
  const out: string[] = []
  for (const domain of domains) {
    if (isValidCspDomain(domain)) out.push(domain.trim())
  }
  return out
}

export function intersectCspDomains(domains: string[], allow?: string[]): string[] {
  const valid = filterCspDomains(domains)
  if (allow === undefined) return valid
  if (allow.length === 0) return []
  const allowed = new Set(allow.filter((d) => isValidCspDomain(d)))
  return valid.filter((d) => allowed.has(d))
}

export function escapeCspPolicy(policy: string): string {
  return policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** Builds the CSP for the app document (MCP Apps default when no domains are declared). */
export function buildCspPolicy(
  csp: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] } = {},
  allowDomains?: string[],
): string {
  const list = (domains?: string[]) => {
    const picked = intersectCspDomains(domains ?? [], allowDomains)
    return picked.length ? ` ${picked.join(' ')}` : ''
  }
  const resources = list(csp.resourceDomains)
  const connect = list(csp.connectDomains)
  const frame = list(csp.frameDomains)
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline'${resources}`,
    `style-src 'unsafe-inline'${resources}`,
    `img-src data: blob:${resources}`,
    `font-src data:${resources}`,
    `media-src data: blob:${resources}`,
    `connect-src${connect || " 'none'"}`,
    `frame-src${frame || " 'none'"}`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ')
}