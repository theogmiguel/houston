export const BROWSER_DEVICES = {
  desktop: null,
  phone: { width: 393, height: 852 },
  tablet: { width: 820, height: 1180 }
} as const
export type BrowserDevice = keyof typeof BROWSER_DEVICES

export function fitBrowserDevice(device: BrowserDevice, width: number, height: number): number {
  const size = BROWSER_DEVICES[device]
  return size ? Math.max(0, Math.min(1, width / size.width, height / size.height)) : 1
}

export function browserSecurity(url: string | null): 'secure' | 'local' | 'not secure' {
  try {
    const parsed = new URL(url ?? '')
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) return 'local'
    return parsed.protocol === 'https:' ? 'secure' : 'not secure'
  } catch { return 'not secure' }
}
