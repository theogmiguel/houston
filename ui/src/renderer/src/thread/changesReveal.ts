/** Asks the app to open the Changes panel at one file; `ChangesPane` selects it once listed. */
export const CHANGES_REVEAL_EVENT = 'houston:changes-reveal'

export interface ChangesReveal {
  /** Absolute, or relative to `cwd`. */
  path: string
  cwd: string
}

// Kept until a Changes list shows the file: the panel may mount after the request.
let pending: ChangesReveal | null = null

export function revealInChanges(reveal: ChangesReveal): void {
  pending = reveal
  window.dispatchEvent(new CustomEvent<ChangesReveal>(CHANGES_REVEAL_EVENT, { detail: reveal }))
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path)

/** The reveal's path relative to `repoDir`, or `null` when it lies outside. Drive letters compare case-insensitively. */
export function repoRelativePath(reveal: ChangesReveal, repoDir: string): string | null {
  const raw = normalise(reveal.path)
  const full = isAbsolute(raw) ? raw : `${normalise(reveal.cwd)}/${raw}`
  const base = normalise(repoDir)
  const drive = /^[A-Za-z]:\//.test(base)
  const prefix = `${base}/`
  const matches = drive ? full.toLowerCase().startsWith(prefix.toLowerCase()) : full.startsWith(prefix)
  return matches ? full.slice(prefix.length) : null
}

/** The pending reveal's path when `paths` lists it for this repository; consumes the reveal. */
export function takeChangesReveal(repoDir: string, paths: readonly string[]): string | null {
  if (pending === null) return null
  const path = repoRelativePath(pending, repoDir)
  if (path === null || !paths.includes(path)) return null
  pending = null
  return path
}
