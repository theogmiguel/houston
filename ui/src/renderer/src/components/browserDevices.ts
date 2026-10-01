import { useEffect, useRef, useState, useCallback } from 'react'
import { isTauri } from '../houston/host'

export const BROWSER_DEVICES = {
  desktop: null,
  phone: { width: 393, height: 852 },
  tablet: { width: 820, height: 1180 }
} as const
// Preview frames keep device proportions legible without filling the entire panel.
export const BROWSER_PREVIEW_FRAMES = { phone: { width: 212, height: 460 }, tablet: { width: 300, height: 430 } } as const
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

export function useBrowserDevice(id: string, stage: { width: number; height: number }) {
  const [deviceRefusal, setDeviceRefusal] = useState<string | null>(null)
  const [nativeReady, setNativeReady] = useState(false)
  const deviceCommands = useRef(Promise.resolve())
  const [device, setDevice] = useState<BrowserDevice>('desktop')
  const size = BROWSER_DEVICES[device]
  const frame = device === 'desktop' ? null : BROWSER_PREVIEW_FRAMES[device]
  const zoom = fitBrowserDevice(device, Math.min(stage.width, frame?.width ?? stage.width), Math.min(stage.height, frame?.height ?? stage.height))
  useEffect(() => {
    if (!isTauri() || !nativeReady || (size && zoom <= 0)) return
    let disposed = false
    deviceCommands.current = deviceCommands.current.then(async () => {
      if (disposed) return
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('browser_set_device', { id: id, width: size?.width ?? null, height: size?.height ?? null, zoom })
      } catch (error) {
        if (!disposed) {
          setDeviceRefusal(error instanceof Error ? error.message : String(error))
          setDevice('desktop')
        }
      }
    })
    return () => { disposed = true }
  }, [nativeReady, id, size, zoom])
  const onReady = useCallback(() => setNativeReady(true), [])
  return { device, setDevice, size, zoom, deviceRefusal, nativeReady, onReady }
}
