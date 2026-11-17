const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

function safeUrl(url: string): string | undefined {
  const trimmed = url.trim()
  return /^(https?:|mailto:|tel:|\/|#|\.\/)/i.test(trimmed) ? trimmed : undefined
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

function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
      // href is already HTML-escaped; unescape &amp; only for the scheme check.
      const url = safeUrl(href.replace(/&amp;/g, '&'))
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : match
    })
}

/**
 * Small, safe Markdown subset (bold, italic, code, links, lists, paragraphs).
 * All text is escaped first; only these tags are produced.
 */
export function renderMarkdown(text: string): string {
  const blocks = escapeHtml(text.replace(/\r\n/g, '\n')).split(/\n{2,}/)
  return blocks
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`
      }
      if (lines.every((l) => /^\s*\d+[.)] /.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('')}</ol>`
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`
    })
    .join('')
}
