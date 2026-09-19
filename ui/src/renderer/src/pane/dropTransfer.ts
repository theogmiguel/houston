// Houston's own file tree and GTK file managers set this on drags: newline-
// separated absolute paths, no `file://` wrapper.
export const FILE_PATH_MIME = 'application/x-file-path'

export const URI_LIST_MIME = 'text/uri-list' // RFC 2483, what GTK/Wayland actually puts on a drag

export const MAX_IMAGE_SAVE_BYTES = 50 * 1024 * 1024

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function checkImageSizeCap(bytes: number): string | null {
  if (bytes <= MAX_IMAGE_SAVE_BYTES) return null
  return `image is ${formatMiB(bytes)}, over the ${formatMiB(MAX_IMAGE_SAVE_BYTES)} limit`
}

export interface DropEntry {
  path?: string
  file?: File
}

export interface DataTransferLike {
  types: ReadonlyArray<string>
  files?: ArrayLike<File> | null
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null
  getData(type: string): string
  dropEffect?: string
  effectAllowed?: string
}

// Per RFC 2483 a `#`-prefixed line is a comment; non-`file:` URIs are dropped
// since there's no path to give a terminal. The leading-slash strip below
// handles Windows' `file:///C:/x` (pathname `/C:/x`).
export function parseUriList(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let path: string | null = null
    try {
      const url = new URL(line)
      if (url.protocol !== 'file:') continue
      path = decodeURIComponent(url.pathname)
    } catch {
      continue
    }
    if (path.startsWith('/') && /^[A-Za-z]:/.test(path.slice(1))) path = path.slice(1)
    if (path) out.push(path)
  }
  return out
}

// Types-only gate (protected mode hides everything else during dragover), so
// deliberately optimistic: a false accept just costs an empty drop, a false
// reject costs the webview navigating away. `items[].kind` still works under WebKit.
export function dragCarriesFiles(dt: DataTransferLike | null | undefined): boolean {
  if (!dt) return false
  const types = Array.from(dt.types ?? [])
  if (types.includes('Files') || types.includes(FILE_PATH_MIME) || types.includes(URI_LIST_MIME)) {
    return true
  }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') return true
  }
  return false
}

// Order matters: FILE_PATH_MIME first (always a real path), then files/items,
// then uri-list last -- each later step runs only if nothing was found yet,
// since a drop advertises the same files on several channels at once.
export function readDropEntries(dt: DataTransferLike | null | undefined): DropEntry[] {
  if (!dt) return []
  const entries: DropEntry[] = []
  const seenPaths = new Set<string>()
  const seenFiles = new Set<string>()

  const pushPath = (path: string): void => {
    if (!path || seenPaths.has(path)) return
    seenPaths.add(path)
    entries.push({ path })
  }
  const pushFile = (file: File | null): void => {
    if (!file) return
    const key = `${file.name}:${file.size}:${file.lastModified}:${file.type}`
    if (seenFiles.has(key)) return
    seenFiles.add(key)
    entries.push({ file })
  }

  for (const line of (dt.getData(FILE_PATH_MIME) || '').split('\n')) {
    pushPath(line.trim())
  }

  for (const file of Array.from(dt.files ?? [])) pushFile(file)

  if (entries.length === 0) {
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind !== 'file') continue
      pushFile(item.getAsFile())
    }
  }

  if (entries.length === 0) {
    for (const path of parseUriList(dt.getData(URI_LIST_MIME) || '')) pushPath(path)
  }

  return entries
}
