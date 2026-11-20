const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

export type MarkdownLinkOptions = {
  /** Hosts absolute http(s) links may use (`example.com`, `*.example.com`). Default: any http(s) host. */
  hosts?: string[]
}

export type MarkdownOptions = {
  links?: MarkdownLinkOptions
}

const MAX_RENDER_CHARS = 100_000
const MAX_LINK_LABEL = 300
const MAX_LINK_HREF = 2048

function hostAllowed(host: string, allow?: string[]): boolean {
  if (!allow?.length) return true
  const lower = host.toLowerCase()
  return allow.some((pattern) => {
    const p = pattern.toLowerCase()
    if (p.startsWith('*.')) return lower === p.slice(2) || lower.endsWith(`.${p.slice(2)}`)
    return lower === p
  })
}

function safeUrl(url: string, options?: MarkdownLinkOptions): string | undefined {
  let trimmed = url.trim()
  if (!trimmed || trimmed.length > MAX_LINK_HREF) return undefined
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('//') || trimmed.startsWith('/\\') || trimmed.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (/^https?:/i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed)
        if (parsed.username || parsed.password) return undefined
        if (!hostAllowed(parsed.hostname, options?.hosts)) return undefined
        return trimmed
      } catch {
        return undefined
      }
    }
    if (/^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed)) return trimmed
    return undefined
  }
  try {
    trimmed = decodeURIComponent(trimmed)
  } catch {
    return undefined
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\') || trimmed.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('#') || trimmed.startsWith('.')) return url.trim()
  return undefined
}

/**
 * Whether `src` may be an image source in the widget: http(s), blob:, a
 * relative path, or base64 data of a raster image type. Anything else
 * (`javascript:`, `data:text/html`, SVG data, leading spaces) is rejected.
 */
export function safeImageUrl(src: string): boolean {
  if (/^(https?:|blob:|\/|\.\/|[\w-]+\/)/i.test(src)) return true
  return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/]*={0,2}$/i.test(src)
}

function inlineLink(label: string, href: string, linkOptions?: MarkdownLinkOptions): string {
  const url = safeUrl(href.replace(/&amp;/g, '&'), linkOptions)
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `[${label}](${href})`
}

function inline(escaped: string, linkOptions?: MarkdownLinkOptions): string {
  // Remembers the next occurrence of each token so unclosed markers don't rescan the rest of the line.
  const next = new Map<string, number>()
  const find = (token: string, from: number): number => {
    const known = next.get(token)
    if (known !== undefined && (known === -1 || known >= from)) return known
    const at = escaped.indexOf(token, from)
    next.set(token, at)
    return at
  }
  let out = ''
  let i = 0
  while (i < escaped.length) {
    if (escaped[i] === '`') {
      const end = find('`', i + 1)
      if (end === -1) {
        out += escaped[i]!
        i++
        continue
      }
      out += `<code>${escaped.slice(i + 1, end)}</code>`
      i = end + 1
      continue
    }
    if (escaped.startsWith('**', i)) {
      const end = find('**', i + 2)
      if (end !== -1) {
        out += `<strong>${escaped.slice(i + 2, end)}</strong>`
        i = end + 2
        continue
      }
    }
    if (escaped[i] === '*' && escaped[i + 1] !== '*' && (i === 0 || escaped[i - 1] !== '*')) {
      const end = find('*', i + 1)
      if (end !== -1 && end > i + 1 && escaped[end - 1] !== ' ' && escaped[end + 1] !== '*') {
        out += `<em>${escaped.slice(i + 1, end)}</em>`
        i = end + 1
        continue
      }
    }
    if (escaped[i] === '[') {
      const closeLabel = find(']', i + 1)
      const openHref = closeLabel !== -1 && escaped[closeLabel + 1] === '(' ? closeLabel + 1 : -1
      const closeHref = openHref !== -1 ? find(')', openHref + 1) : -1
      const label = closeLabel !== -1 ? escaped.slice(i + 1, closeLabel) : ''
      const hrefStart = openHref !== -1 ? openHref + 1 : -1
      const href = closeHref !== -1 && hrefStart !== -1 ? escaped.slice(hrefStart, closeHref) : ''
      const valid =
        closeLabel !== -1 &&
        closeHref !== -1 &&
        label.length > 0 &&
        label.length <= MAX_LINK_LABEL &&
        href.length > 0 &&
        href.length <= MAX_LINK_HREF &&
        !/[\s]/.test(href) &&
        !label.includes('[') &&
        !label.includes(']')
      if (valid) {
        out += inlineLink(label, href, linkOptions)
        i = closeHref + 1
        continue
      }
    }
    out += escaped[i]!
    i++
  }
  return out
}

/**
 * Small, safe Markdown subset (bold, italic, code, links, lists, paragraphs).
 * All text is escaped first; only these tags are produced.
 */
export function renderMarkdown(text: string, options?: MarkdownOptions): string {
  if (text.length > MAX_RENDER_CHARS) return `<p>${escapeHtml(text)}</p>`
  const blocks = escapeHtml(text.replace(/\r\n/g, '\n')).split(/\n{2,}/)
  const linkOptions = options?.links
  return blocks
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''), linkOptions)}</li>`).join('')}</ul>`
      }
      if (lines.every((l) => /^\s*\d+[.)] /.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''), linkOptions)}</li>`).join('')}</ol>`
      }
      return `<p>${lines.map((line) => inline(line, linkOptions)).join('<br>')}</p>`
    })
    .join('')
}