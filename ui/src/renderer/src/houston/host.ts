
export interface HostConfig {
  port: number
  token: string
}

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

export function isWindows(platform = navigator.platform): boolean {
  return platform.startsWith('Win')
}

export async function getHostConfig(): Promise<HostConfig> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<HostConfig>('host_config')
  }
  return window.houston.getConfig()
}
