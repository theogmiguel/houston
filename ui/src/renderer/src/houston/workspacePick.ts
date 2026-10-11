import { listEnvironments } from './environments'
import { parseWslPath } from './wslPath'

/** `wire` is what `workspace_add` carries (the mux reads the distro from a
 *  `\\wsl.localhost` path); `path` is the workspace path the rail will list. */
export type WorkspacePick = { wire: string; path: string } | { refusal: string }

export async function resolveWorkspacePick(picked: string): Promise<WorkspacePick> {
  const wsl = parseWslPath(picked)
  if (wsl === null) return { wire: picked, path: picked }
  const env = (await listEnvironments()).find((e) => e.kind === 'wsl' && e.distro === wsl.distro)
  if (env === undefined) return { refusal: `Enable ${wsl.distro} in Settings → WSL to open folders from it` }
  if (env.state !== 'ready') return { refusal: `WSL: ${wsl.distro} is not ready yet (${env.reason ?? env.state})` }
  return { wire: picked, path: wsl.path }
}
