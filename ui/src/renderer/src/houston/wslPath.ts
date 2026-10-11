export interface WslLocation {
  distro: string
  path: string
}

// `\\wsl.localhost\D\...`, `\\wsl$\D\...` and the `\\?\UNC\wsl.localhost\D\...` form
// that a canonicalized path takes; the host name is case-insensitive.
const WSL_UNC = /^\\\\(?:\?\\UNC\\)?(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i

export function parseWslPath(path: string): WslLocation | null {
  const match = WSL_UNC.exec(path)
  if (match === null) return null
  const segments = (match[2] ?? '').split('\\').filter((s) => s !== '')
  return { distro: match[1], path: `/${segments.join('/')}` }
}

export function wslUncPath(distro: string, posix: string): string {
  const rest = posix.split('/').filter((s) => s !== '').join('\\')
  return `\\\\wsl.localhost\\${distro}\\${rest}`
}
