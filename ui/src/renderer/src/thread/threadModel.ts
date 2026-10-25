import type { QuestionAnswer, QuestionOutcome, ThreadEvent, ThreadQuestion, ToolSummary, TurnOutcome } from './threadTypes'

export interface ToolResultView {
  isError: boolean
  output: string
  truncated: boolean
}

/** A permission request's state: `withdrawn` when Claude stopped waiting or Houston restarted. */
export type ApprovalState = 'pending' | 'allowed' | 'denied' | 'withdrawn'

export type QuestionState = 'pending' | QuestionOutcome

/** The tool whose permission request carries a plan; its card shows the plan, not the raw input. */
export const PLAN_TOOL = 'ExitPlanMode'

export interface ChangedFile {
  path: string
  added: number
  removed: number
}

export type ThreadItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string; streaming: boolean; truncated: boolean }
  // Claude's headless stream sends no reasoning text: a row shows how long and how much.
  | { kind: 'reasoning'; key: string; streaming: boolean; redacted: boolean; durationMs: number | null; tokens: number | null }
  | { kind: 'tool'; key: string; name: string; input: string; inputTruncated: boolean; summary: ToolSummary | null; result: ToolResultView | null; settled: boolean }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'stopped'; key: string }
  | { kind: 'error'; key: string; text: string }
  | { kind: 'approval'; key: string; requestId: string; name: string; input: string; inputTruncated: boolean; inputBytes: number; state: ApprovalState; reason: string | null }
  | { kind: 'question'; key: string; requestId: string; questions: readonly ThreadQuestion[]; truncated: boolean; state: QuestionState; answers: readonly QuestionAnswer[]; reason: string | null }
  // Rows `foldThreadRows` adds for a settled turn.
  | { kind: 'turn'; key: string; turn: string; label: string; outcome: TurnOutcome; expanded: boolean }
  | { kind: 'changes'; key: string; files: readonly ChangedFile[] }

/** A turn runs from a user message to its `turn_end`; `key` is the user message's seq. */
export interface TurnSpan {
  key: string
  startMs: number
  endMs: number | null
  outcome: TurnOutcome | null
}

export interface ThreadTimeline {
  items: ThreadItem[]
  /** Each item's turn, by index; `null` before the first loaded user message and between turns. */
  turnOf: (string | null)[]
  turns: ReadonlyMap<string, TurnSpan>
}

export function buildThreadItems(events: readonly ThreadEvent[]): ThreadItem[] {
  return buildThreadTimeline(events).items
}

// Folds the event log into rows. Deltas stream into one row per block until its stored
// message or reasoning replaces them; deltas arriving after that are stale and skipped.
export function buildThreadTimeline(events: readonly ThreadEvent[]): ThreadTimeline {
  const items: ThreadItem[] = []
  const turnOf: (string | null)[] = []
  const turns = new Map<string, TurnSpan>()
  let turn: TurnSpan | null = null
  const push = (item: ThreadItem): void => {
    items.push(item)
    turnOf.push(turn?.key ?? null)
  }
  const tools = new Map<string, number>()
  const approvals = new Map<string, number>()
  const questions = new Map<string, number>()
  const stored = new Set<string>()
  const thinking = new Map<string, number>()
  let turnStart = 0
  let open: { messageId: string; index: number } | null = null
  const stopThinking = (): void => {
    for (const at of thinking.values()) {
      const item = items[at]
      if (item?.kind === 'reasoning') items[at] = { ...item, streaming: false }
    }
    thinking.clear()
  }
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
        stopThinking()
        turnStart = items.length
        turn = { key, startMs: event.at_ms, endMs: null, outcome: null }
        turns.set(key, turn)
        push({ kind: 'user', key, text: kind.text })
        break
      case 'assistant_delta': {
        if (stored.has(kind.message_id)) break
        const current = open !== null && open.messageId === kind.message_id ? items[open.index] : undefined
        if (current?.kind === 'assistant' && open !== null) {
          items[open.index] = { ...current, text: current.text + kind.text }
        } else {
          freeze()
          open = { messageId: kind.message_id, index: items.length }
          push({ kind: 'assistant', key: `delta-${key}`, text: kind.text, streaming: true, truncated: false })
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
          push({ kind: 'assistant', key, text: kind.text, streaming: false, truncated: kind.truncated })
        }
        break
      // Reasoning streams beside the answer: neither freezes the other.
      case 'reasoning_delta': {
        if (stored.has(kind.message_id)) break
        const at = thinking.get(kind.message_id)
        const current = at === undefined ? undefined : items[at]
        const tokens = kind.estimated_tokens ?? null
        if (current?.kind === 'reasoning' && at !== undefined) {
          if (tokens !== null) items[at] = { ...current, tokens }
        } else {
          thinking.set(kind.message_id, items.length)
          push({ kind: 'reasoning', key: `delta-${key}`, streaming: true, redacted: false, durationMs: null, tokens })
        }
        break
      }
      case 'reasoning': {
        stored.add(kind.message_id)
        const row: ThreadItem = { kind: 'reasoning', key, streaming: false, redacted: kind.redacted, durationMs: kind.duration_ms ?? null, tokens: kind.estimated_tokens ?? null }
        const at = thinking.get(kind.message_id)
        if (at !== undefined && items[at]?.kind === 'reasoning') {
          items[at] = row
          thinking.delete(kind.message_id)
        } else {
          push(row)
        }
        break
      }
      case 'tool_call':
        freeze()
        tools.set(kind.tool_use_id, items.length)
        push({ kind: 'tool', key, name: kind.name, input: kind.input, inputTruncated: kind.truncated, summary: kind.summary ?? null, result: null, settled: false })
        break
      case 'tool_result': {
        const result = { isError: kind.is_error, output: kind.output, truncated: kind.truncated }
        const at = tools.get(kind.tool_use_id)
        const call = at === undefined ? undefined : items[at]
        if (call?.kind === 'tool' && at !== undefined) {
          items[at] = { ...call, result }
          tools.delete(kind.tool_use_id)
        } else {
          push({ kind: 'tool', key, name: 'Tool result', input: '', inputTruncated: false, summary: null, result, settled: true })
        }
        break
      }
      case 'turn_end':
        freeze()
        stopThinking()
        settle()
        if (kind.outcome !== 'completed') untruncateStopped(items, turnStart)
        if (kind.outcome === 'interrupted') push({ kind: 'stopped', key })
        else if (kind.outcome === 'error') push({ kind: 'error', key, text: kind.error ?? 'The turn ended with an error the CLI did not describe.' })
        if (turn !== null) {
          turn.endMs = event.at_ms
          turn.outcome = kind.outcome
        }
        turn = null
        break
      case 'notice':
        freeze()
        push({ kind: 'notice', key, text: kind.text })
        break
      // Requests come from the MCP path, deltas from stdout: an open answer keeps streaming.
      case 'approval_request':
        approvals.set(kind.request_id, items.length)
        push({ kind: 'approval', key, requestId: kind.request_id, name: kind.tool_name, input: kind.input, inputTruncated: kind.truncated, inputBytes: kind.input_bytes, state: 'pending', reason: null })
        break
      case 'approval_resolved': {
        const at = approvals.get(kind.request_id)
        const item = at === undefined ? undefined : items[at]
        if (item?.kind === 'approval' && at !== undefined) items[at] = { ...item, state: kind.decision, reason: kind.reason ?? null }
        break
      }
      case 'question_request':
        questions.set(kind.request_id, items.length)
        push({ kind: 'question', key, requestId: kind.request_id, questions: kind.questions, truncated: kind.truncated, state: 'pending', answers: [], reason: null })
        break
      case 'question_resolved': {
        const at = questions.get(kind.request_id)
        const item = at === undefined ? undefined : items[at]
        if (item?.kind === 'question' && at !== undefined) items[at] = { ...item, state: kind.outcome, answers: kind.answers, reason: kind.reason ?? null }
        break
      }
    }
  }
  return { items, turnOf, turns }
}

// A stopped or failed turn's partial answer is stored as truncated; the row after it already says why.
function untruncateStopped(items: ThreadItem[], turnStart: number): void {
  for (let at = items.length - 1; at >= turnStart; at--) {
    const item = items[at]
    if (item?.kind !== 'assistant') continue
    if (item.truncated) items[at] = { ...item, truncated: false }
    return
  }
}

/** The newest question still waiting for the user; its card takes the composer's place. */
export function pendingQuestion(items: readonly ThreadItem[]): Extract<ThreadItem, { kind: 'question' }> | null {
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]!
    if (item.kind === 'question' && item.state === 'pending') return item
  }
  return null
}

/** The plan of an `ExitPlanMode` request, or `null` when its input is not whole JSON (cut at the cap). */
export function planText(input: string): string | null {
  const plan = parseToolInput(input)?.plan
  return typeof plan === 'string' ? plan : null
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
    case 'reasoning': {
      const other = b as typeof a
      return a.streaming === other.streaming && a.redacted === other.redacted && a.durationMs === other.durationMs && a.tokens === other.tokens
    }
    case 'tool': {
      const other = b as typeof a
      const ra = a.result
      const rb = other.result
      return a.name === other.name && a.input === other.input && a.inputTruncated === other.inputTruncated && a.settled === other.settled && sameSummary(a.summary, other.summary) &&
        (ra === rb || (ra !== null && rb !== null && ra.isError === rb.isError && ra.output === rb.output && ra.truncated === rb.truncated))
    }
    case 'turn': {
      const other = b as typeof a
      return a.label === other.label && a.outcome === other.outcome && a.expanded === other.expanded
    }
    case 'changes': {
      const other = b as typeof a
      return a.files.length === other.files.length && a.files.every((file, i) => {
        const peer = other.files[i]!
        return file.path === peer.path && file.added === peer.added && file.removed === peer.removed
      })
    }
    case 'stopped':
      return true
    case 'approval': {
      const other = b as typeof a
      return a.requestId === other.requestId && a.name === other.name && a.input === other.input && a.inputTruncated === other.inputTruncated && a.inputBytes === other.inputBytes && a.state === other.state && a.reason === other.reason
    }
    // Questions and answers come from stored events, so a rebuilt row keeps the same arrays.
    case 'question': {
      const other = b as typeof a
      return a.requestId === other.requestId && a.questions === other.questions && a.truncated === other.truncated && a.state === other.state && a.answers === other.answers && a.reason === other.reason
    }
  }
}

function sameSummary(a: ToolSummary | null, b: ToolSummary | null): boolean {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.target === b.target && a.added === b.added && a.removed === b.removed)
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
