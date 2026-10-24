import type { ThreadEvent } from './threadTypes'

export interface ToolResultView {
  isError: boolean
  output: string
  truncated: boolean
}

export type ThreadItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string; streaming: boolean; truncated: boolean }
  | { kind: 'tool'; key: string; name: string; input: string; inputTruncated: boolean; result: ToolResultView | null; settled: boolean }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'stopped'; key: string }
  | { kind: 'error'; key: string; text: string }

// Folds the event log into rows. Deltas stream into one row per message until its stored
// `assistant_message` replaces them; deltas arriving after that are stale and skipped.
export function buildThreadItems(events: readonly ThreadEvent[]): ThreadItem[] {
  const items: ThreadItem[] = []
  const tools = new Map<string, number>()
  const stored = new Set<string>()
  let turnStart = 0
  let open: { messageId: string; index: number } | null = null
  const settle = (): void => {
    for (const at of tools.values()) {
      const item = items[at]
      if (item?.kind === 'tool' && item.result === null && !item.settled) items[at] = { ...item, settled: true }
    }
    tools.clear()
  }
  const freeze = (): void => {
    if (open === null) return
    const item = items[open.index]
    if (item?.kind === 'assistant') items[open.index] = { ...item, streaming: false }
    open = null
  }
  for (const event of events) {
    const kind = event.kind
    const key = String(event.seq)
    switch (kind.type) {
      case 'user_message':
        freeze()
        turnStart = items.length
        items.push({ kind: 'user', key, text: kind.text })
        break
      case 'assistant_delta': {
        if (stored.has(kind.message_id)) break
        const current = open !== null && open.messageId === kind.message_id ? items[open.index] : undefined
        if (current?.kind === 'assistant' && open !== null) {
          items[open.index] = { ...current, text: current.text + kind.text }
        } else {
          freeze()
          open = { messageId: kind.message_id, index: items.length }
          items.push({ kind: 'assistant', key: `delta-${key}`, text: kind.text, streaming: true, truncated: false })
        }
        break
      }
      case 'assistant_message':
        stored.add(kind.message_id)
        if (open !== null && open.messageId === kind.message_id) {
          items[open.index] = { kind: 'assistant', key, text: kind.text, streaming: false, truncated: kind.truncated }
          open = null
        } else {
          freeze()
          items.push({ kind: 'assistant', key, text: kind.text, streaming: false, truncated: kind.truncated })
        }
        break
      case 'tool_call':
        freeze()
        tools.set(kind.tool_use_id, items.length)
        items.push({ kind: 'tool', key, name: kind.name, input: kind.input, inputTruncated: kind.truncated, result: null, settled: false })
        break
      case 'tool_result': {
        const result = { isError: kind.is_error, output: kind.output, truncated: kind.truncated }
        const at = tools.get(kind.tool_use_id)
        const call = at === undefined ? undefined : items[at]
        if (call?.kind === 'tool' && at !== undefined) {
          items[at] = { ...call, result }
          tools.delete(kind.tool_use_id)
        } else {
          items.push({ kind: 'tool', key, name: 'Tool result', input: '', inputTruncated: false, result, settled: true })
        }
        break
      }
      case 'turn_end':
        freeze()
        settle()
        if (kind.outcome === 'interrupted') {
          untruncateStopped(items, turnStart)
          items.push({ kind: 'stopped', key })
        }
        else if (kind.outcome === 'error') items.push({ kind: 'error', key, text: kind.error ?? 'The turn ended with an error the CLI did not describe.' })
        break
      case 'notice':
        freeze()
        items.push({ kind: 'notice', key, text: kind.text })
        break
    }
  }
  return items
}

// A stopped turn's partial answer is stored as truncated; the Stopped marker already says so.
function untruncateStopped(items: ThreadItem[], turnStart: number): void {
  for (let at = items.length - 1; at >= turnStart; at--) {
    const item = items[at]
    if (item?.kind !== 'assistant') continue
    if (item.truncated) items[at] = { ...item, truncated: false }
    return
  }
}

/** A turn is open when the newest user message has no turn end after it. */
export function turnOpen(events: readonly ThreadEvent[]): boolean {
  for (let at = events.length - 1; at >= 0; at--) {
    const type = events[at]!.kind.type
    if (type === 'turn_end') return false
    if (type === 'user_message') return true
  }
  return false
}

/** Field-wise equality, so a rebuilt row with unchanged content skips re-rendering. */
export function sameThreadItem(a: ThreadItem, b: ThreadItem): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.key !== b.key) return false
  switch (a.kind) {
    case 'user':
    case 'notice':
    case 'error':
      return a.text === (b as typeof a).text
    case 'assistant':
      return a.text === (b as typeof a).text && a.streaming === (b as typeof a).streaming && a.truncated === (b as typeof a).truncated
    case 'tool': {
      const other = b as typeof a
      const ra = a.result
      const rb = other.result
      return a.name === other.name && a.input === other.input && a.inputTruncated === other.inputTruncated && a.settled === other.settled &&
        (ra === rb || (ra !== null && rb !== null && ra.isError === rb.isError && ra.output === rb.output && ra.truncated === rb.truncated))
    }
    case 'stopped':
      return true
  }
}

export interface ThreadWindow {
  /** Rendered row count. */
  size: number
  /** Key of the last rendered row; `null` follows the newest row. */
  end: string | null
}

/** Rows rendered by default, and per "Show earlier" / "Show later" step. */
export const THREAD_WINDOW_PAGE = 150
/** Upper bound on rendered rows, so a long thread keeps a bounded DOM. */
export const THREAD_WINDOW_MAX = 400

export const LATEST_WINDOW: ThreadWindow = { size: THREAD_WINDOW_PAGE, end: null }

export function windowBounds(items: readonly ThreadItem[], win: ThreadWindow): { start: number; end: number } {
  const found = win.end === null ? -1 : items.findIndex((item) => item.key === win.end)
  const end = win.end === null || found < 0 ? items.length : found + 1
  return { start: Math.max(0, end - win.size), end }
}

/** Grows the window backwards until it reaches the cap, then slides it. */
export function showEarlier(items: readonly ThreadItem[], win: ThreadWindow): ThreadWindow {
  if (win.size + THREAD_WINDOW_PAGE <= THREAD_WINDOW_MAX) return { ...win, size: win.size + THREAD_WINDOW_PAGE }
  const { start, end } = windowBounds(items, { ...win, size: THREAD_WINDOW_MAX })
  if (start === 0) return { ...win, size: THREAD_WINDOW_MAX }
  const shifted = Math.max(end - THREAD_WINDOW_PAGE, THREAD_WINDOW_MAX)
  return { size: THREAD_WINDOW_MAX, end: items[shifted - 1]?.key ?? win.end }
}

export function showLater(items: readonly ThreadItem[], win: ThreadWindow): ThreadWindow {
  const { end } = windowBounds(items, win)
  const next = end + THREAD_WINDOW_PAGE
  return next >= items.length ? { ...win, end: null } : { ...win, end: items[next - 1]!.key }
}

export type DiffRow = { kind: 'ctx' | 'add' | 'del' | 'hunk'; text: string }

const DIFF_CONTEXT = 3

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** A line diff of one replacement: shared leading and trailing lines become context. */
export function replacementDiff(before: string, after: string): DiffRow[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const rows: DiffRow[] = []
  for (const text of a.slice(Math.max(0, head - DIFF_CONTEXT), head)) rows.push({ kind: 'ctx', text })
  for (const text of a.slice(head, a.length - tail)) rows.push({ kind: 'del', text })
  for (const text of b.slice(head, b.length - tail)) rows.push({ kind: 'add', text })
  for (const text of a.slice(a.length - tail, a.length - tail + DIFF_CONTEXT)) rows.push({ kind: 'ctx', text })
  return rows
}

export function writeDiff(content: string): DiffRow[] {
  return splitLines(content).map((text) => ({ kind: 'add', text }))
}

/** The tool's input object, or `null` when the text is not a JSON object (for example cut at the cap). */
export function parseToolInput(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'] as const
const SUMMARY_MAX = 160

/** One line naming what a tool call acts on, for the collapsed card. */
export function toolSummary(input: string): string {
  const parsed = parseToolInput(input)
  if (parsed !== null) {
    for (const key of SUMMARY_KEYS) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
    }
  }
  return oneLine(input)
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat
}
