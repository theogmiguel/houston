import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'tr-pr-viewed-marks'

// 200 pull requests: an LRU of the reviews a user actually cycles through.
// Past the cap the oldest PR falls off and its files read as unviewed again,
// which is the behaviour this store exists to improve on, not to corrupt.
const MAX_PRS = 200

export type PrFileViewedState = 'viewed' | 'changed' | 'unviewed'

interface PrViewedEntry {
  at: number
  files: Record<string, string>
}

const EMPTY_FILES: Readonly<Record<string, string>> = {}

/** `${host}/${repository}#${number}`: a fork or a same-numbered request in
 * another repository must never share another's marks. */
export function prViewedKey(host: string, repository: string, number: number): string {
  return `${host}/${repository}#${number}`
}

function fnv1a(text: string, backwards: boolean): number {
  let hash = 0x811c9dc5
  const step = backwards ? -1 : 1
  for (let index = backwards ? text.length - 1 : 0; index >= 0 && index < text.length; index += step) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A 16-hex-digit fingerprint of one file's patch text, taken at mark time.
 * Two FNV-1a passes (forward and backward) stand in for the unavailable
 * synchronous digest; a patch that differs in any line differs here. */
export function patchHash(text: string): string {
  return fnv1a(text, false).toString(16).padStart(8, '0') + fnv1a(text, true).toString(16).padStart(8, '0')
}

/** The mark's meaning against the patch now on screen: a stored hash that no
 * longer matches is a file that changed after it was viewed, never a silent
 * viewed state. */
export function viewedState(storedHash: string | undefined, currentHash: string): PrFileViewedState {
  if (storedHash === undefined) return 'unviewed'
  return storedHash === currentHash ? 'viewed' : 'changed'
}

function isEntry(value: unknown): value is PrViewedEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.at !== 'number' || !Number.isFinite(entry.at) || typeof entry.files !== 'object' || entry.files === null) {
    return false
  }
  return Object.values(entry.files).every((hash) => typeof hash === 'string')
}

function load(): Map<string, PrViewedEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return new Map()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map()
    const out = new Map<string, PrViewedEntry>()
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isEntry(value)) out.set(key, { at: value.at, files: { ...value.files } })
    }
    return out
  } catch {
    // Unreadable storage means every file reads unviewed this session, the
    // behaviour before the store existed — never a blocked PR panel.
    return new Map()
  }
}

let entries: Map<string, PrViewedEntry> = load()
const listeners = new Set<() => void>()

function persist(): void {
  try {
    const record: Record<string, PrViewedEntry> = {}
    for (const [key, entry] of entries) record[key] = entry
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Persistence is a convenience; the in-memory map keeps the session honest.
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribePrViewedMarks(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The stored per-file hashes for one pull request. The returned reference is
 * stable between writes, so it can serve as a `useSyncExternalStore` snapshot. */
export function prViewedMarks(prKey: string | null): Readonly<Record<string, string>> {
  if (prKey === null) return EMPTY_FILES
  return entries.get(prKey)?.files ?? EMPTY_FILES
}

export function usePrViewedMarks(prKey: string | null): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribePrViewedMarks, () => prViewedMarks(prKey), () => EMPTY_FILES)
}

/** Records a file as viewed, fingerprinting its patch text as it stands now. */
export function markPrFileViewed(prKey: string | null, path: string, hash: string): void {
  if (prKey === null) return
  const previous = entries.get(prKey)
  const files = { ...(previous?.files ?? {}), [path]: hash }
  entries = new Map(entries).set(prKey, { at: Date.now(), files })
  while (entries.size > MAX_PRS) {
    let oldestKey: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of entries) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at
        oldestKey = key
      }
    }
    if (oldestKey === null) break
    entries.delete(oldestKey)
  }
  persist()
  notify()
}

/** Withdraws a viewed mark: the file reads unviewed again, in this and later
 * sessions. */
export function markPrFileUnviewed(prKey: string | null, path: string): void {
  if (prKey === null) return
  const previous = entries.get(prKey)
  if (previous === undefined || !(path in previous.files)) return
  const files = { ...previous.files }
  delete files[path]
  if (Object.keys(files).length === 0) entries.delete(prKey)
  else entries = new Map(entries).set(prKey, { at: Date.now(), files })
  persist()
  notify()
}

export function clearPrViewedMarksForTests(): void {
  entries = new Map()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
  }
}
