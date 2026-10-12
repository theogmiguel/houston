export function prRelativeAge(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now / 1000 - timestamp) / 60))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}
