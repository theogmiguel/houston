export function parseTagColor(value: string): string | null {
  const input = value.trim().toLowerCase()
  const short = input.match(/^#?([0-9a-f]{3})$/)
  if (short)
    return `#${short[1]
      .split('')
      .map((c) => c + c)
      .join('')}`
  const full = input.match(/^#?([0-9a-f]{6})$/)
  if (full) return `#${full[1]}`
  const rgb = input.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/)
  if (rgb) {
    const values = rgb.slice(1).map(Number)
    if (values.every((v) => v <= 255)) return `#${values.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  return null
}
