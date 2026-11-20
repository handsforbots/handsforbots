/** Same rules as @handsforbots/widget safeImageUrl (plugins do not import each other). */
export function safeImageUrl(src: string): boolean {
  if (/^(https?:|blob:|\/|\.\/|[\w-]+\/)/i.test(src)) return true
  return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/]*={0,2}$/i.test(src)
}

export function safeRasterMime(mime: string | undefined): boolean {
  if (!mime) return false
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime.split(';')[0] ?? '')
}