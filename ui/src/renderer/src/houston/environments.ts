export interface EnvironmentEntry {
  id: string
  kind: 'local' | 'wsl'
  distro?: string
  slot: number
  port: number
  token: string
  state: 'starting' | 'ready' | 'error'
  reason?: string
}

// POSIX workspace path -> distro, kept by the environment mux from each WSL daemon's
// workspace list. Empty whenever no WSL environment is enabled.
export const wslWorkspaces = new Map<string, string>()

export function wslWorkspaceOf(path: string): { root: string; distro: string } | null {
  let best: { root: string; distro: string } | null = null
  for (const [root, distro] of wslWorkspaces) {
    const inside = path === root || path.startsWith(root === '/' ? root : `${root}/`)
    if (inside && (best === null || root.length > best.root.length)) best = { root, distro }
  }
  return best
}

export async function listEnvironments(): Promise<EnvironmentEntry[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<EnvironmentEntry[]>('env_list')
}
