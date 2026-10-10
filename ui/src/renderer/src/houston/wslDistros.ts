export type WslDistroStatus = 'disabled' | 'starting' | 'ready' | 'error'

export interface WslDistro {
  name: string
  /** wsl.exe's own, localized state word; shown as is. */
  state: string
  version: number
  default: boolean
  enabled: boolean
  slot?: number
  status: WslDistroStatus
}

export interface WslList {
  available: boolean
  reason?: string
  distros: WslDistro[]
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = await import('@tauri-apps/api/core')
  return tauri.invoke<T>(cmd, args)
}

export function wslList(): Promise<WslList> {
  return invoke<WslList>('wsl_list')
}

export function wslEnable(name: string): Promise<{ name: string; slot: number; status: WslDistroStatus }> {
  return invoke('wsl_enable', { name })
}

export function wslDisable(name: string): Promise<{ name: string }> {
  return invoke('wsl_disable', { name })
}

export async function onEnvironmentsChanged(handler: () => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen('wsl://environments', handler)
}
