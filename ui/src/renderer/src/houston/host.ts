
export interface HostConfig {
  port: number
  token: string
}

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

export async function getHostConfig(): Promise<HostConfig> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<HostConfig>('host_config')
  }
  return window.houston.getConfig()
}
