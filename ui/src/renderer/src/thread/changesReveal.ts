/** Asks the app to open the Changes panel at one file; `ChangesPane` selects it once listed. */
export const CHANGES_REVEAL_EVENT = 'houston:changes-reveal'

export interface ChangesReveal {
  /** Absolute, or relative to `cwd`. */
  path: string
  cwd: string
}

// Long enough for the panel to mount and list a large repository; a later list must not
// move the selection unasked.
export const CHANGES_REVEAL_TTL_MS = 10_000

// Kept until the panel lists the request's repository: it may mount after the request.
let pending: { reveal: ChangesReveal; expires: number } | null = null

export function revealInChanges(reveal: ChangesReveal): void {
  pending = { reveal, expires: Date.now() + CHANGES_REVEAL_TTL_MS }
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

/** The reveal's path when this repository's first list (`null` while loading) shows it; that list consumes the reveal either way. */
export function takeChangesReveal(repoDir: string, paths: readonly string[] | null): string | null {
  if (pending === null) return null
  if (Date.now() > pending.expires) {
    pending = null
    return null
  }
  const path = repoRelativePath(pending.reveal, repoDir)
  if (path === null || paths === null) return null
  pending = null
  return paths.includes(path) ? path : null
}
