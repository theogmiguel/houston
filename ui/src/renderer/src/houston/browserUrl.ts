export interface WebviewEl extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  capturePage?: () => Promise<{ toDataURL(): string }>
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}
