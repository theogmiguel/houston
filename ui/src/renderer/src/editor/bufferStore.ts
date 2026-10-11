// CodeMirror-free bookkeeping: no runtime import of codemirror/@codemirror/*
// here, and `buffers.ts` is reached only through a dynamic `import()` when an
// editor pane opens, keeping the ~430 KB runtime stack off the boot path.
import type { EditorState, Extension } from '@codemirror/state'

// Bound retained tab documents and keep the tab strip manageable.
export const FILES_TABS_MAX = 12
export const FILES_TABS_STORAGE_PREFIX = 'tr-files-tabs:'
export const fileTabOwners = new Map<string, { workspace: string; paths: string[] }>()
export const DOCUMENT_TABS_EVENT = 'houston-document-tabs'

export interface EditorBuffer {
  state: EditorState
  dirty: boolean
  sha256?: string
  mtimeMs: number | null
  conflict: boolean
  wrap: boolean
// Recorded, not derived: `EditorState.create({ doc })` splits on /\r\n?|\n/
// and drops terminators, so a CRLF file is indistinguishable from an LF one.
// Flips to 'LF' on first save, which really does normalize the file to LF.
  lineEnding: LineEnding
}

export type LineEnding = 'LF' | 'CRLF'

export function detectLineEnding(content: string): LineEnding {
  const lf = content.indexOf('\n')
  if (lf < 0) return 'LF'
  return lf > 0 && content[lf - 1] === '\r' ? 'CRLF' : 'LF'
}

export interface RevealRequest {
  line: number
  col?: number
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path
}

export function cleanError(e: unknown): string {
  return String((e as Error).message ?? e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

export function bufferKey(workspaceDir: string, path: string): string {
  return `${workspaceDir}\0${path}`
}

export interface StoreEntry {
  buf: EditorBuffer
  revision?: Promise<string>
  extensions: Extension[]
}

export const store = new Map<string, StoreEntry>()
const listeners = new Map<string, Set<() => void>>()
const pendingReveal = new Map<string, RevealRequest>()
const revealListeners = new Map<string, Set<(req: RevealRequest) => void>>()

export function notify(key: string): void {
  for (const fn of listeners.get(key) ?? []) fn()
}

export function subscribeBuffer(workspaceDir: string, path: string, fn: () => void): () => void {
  const key = bufferKey(workspaceDir, path)
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(key)
  }
}

export function getBuffer(workspaceDir: string, path: string): EditorBuffer | undefined {
  return store.get(bufferKey(workspaceDir, path))?.buf
}

export function noteUpdate(
  workspaceDir: string,
  path: string,
  state: EditorState,
  docChanged: boolean
): void {
  const key = bufferKey(workspaceDir, path)
  const e = store.get(key)
  if (!e) return
  e.buf = { ...e.buf, state, dirty: docChanged || e.buf.dirty }
  notify(key)
}

export const bufferLoads = new Map<string, Promise<EditorBuffer>>()
const retained = new Map<string, { count: number }>()

export function retainBuffer(workspaceDir: string, path: string): () => void {
  const key = bufferKey(workspaceDir, path)
  const owner = retained.get(key) ?? { count: 0 }
  retained.set(key, owner)
  owner.count++
  let released = false
  return () => {
    if (released) return
    released = true
    owner.count--
    // Transfers and React effect replacement acquire their new owner in this turn.
    queueMicrotask(() => {
      if (retained.get(key) !== owner || owner.count !== 0) return
      retained.delete(key)
      closeBuffer(workspaceDir, path)
    })
  }
}

export function closeBuffer(workspaceDir: string, path: string): void {
  const key = bufferKey(workspaceDir, path)
  if ((retained.get(key)?.count ?? 0) > 0) return
  bufferLoads.delete(key)
  pendingReveal.delete(key)
  store.delete(key)
  notify(key)
}

export function dirtyBufferPaths(workspaceDir: string): string[] {
  const prefix = `${workspaceDir}\0`
  const out: string[] = []
  for (const [key, e] of store) {
    if (key.startsWith(prefix) && e.buf.dirty) out.push(key.slice(prefix.length))
  }
  return out.sort()
}

export function dropWorkspaceBuffers(workspaceDir: string): void {
  const prefix = `${workspaceDir}\0`
  for (const [owner, tabs] of fileTabOwners) if (tabs.workspace === workspaceDir) fileTabOwners.delete(owner)
  for (const key of new Set([...store.keys(), ...bufferLoads.keys(), ...retained.keys(), ...pendingReveal.keys()])) {
    if (key.startsWith(prefix)) {
      store.delete(key)
      bufferLoads.delete(key)
      pendingReveal.delete(key)
      retained.delete(key)
      notify(key)
    }
  }
}

export function requestReveal(workspaceDir: string, path: string, line: number, col?: number): void {
  const key = bufferKey(workspaceDir, path)
  const req: RevealRequest = { line, col }
  const fns = revealListeners.get(key)
  if (fns && fns.size > 0) {
    for (const fn of fns) fn(req)
  } else {
    pendingReveal.set(key, req)
  }
}

export function takePendingReveal(workspaceDir: string, path: string): RevealRequest | undefined {
  const key = bufferKey(workspaceDir, path)
  const req = pendingReveal.get(key)
  pendingReveal.delete(key)
  return req
}

export function onReveal(
  workspaceDir: string,
  path: string,
  fn: (req: RevealRequest) => void
): () => void {
  const key = bufferKey(workspaceDir, path)
  let set = revealListeners.get(key)
  if (!set) {
    set = new Set()
    revealListeners.set(key, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) revealListeners.delete(key)
  }
}
