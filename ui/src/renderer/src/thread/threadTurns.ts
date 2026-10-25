import { parseToolInput, replacementDiff, toolSummary, type ChangedFile, type ThreadItem, type ThreadTimeline } from './threadModel'
import type { ToolKind, ToolSummary, TurnOutcome } from './threadTypes'

type ToolItem = Extract<ThreadItem, { kind: 'tool' }>

// The daemon sends `summary` from v153; this mirrors its tool-name table for events stored earlier.
const KIND_BY_NAME: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Bash: 'command',
  PowerShell: 'command',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  TodoWrite: 'todo',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
  Task: 'task'
}

const TARGET_KEYS: Partial<Record<ToolKind, readonly string[]>> = {
  read: ['file_path', 'notebook_path', 'path'],
  edit: ['file_path', 'notebook_path', 'path'],
  write: ['file_path', 'path'],
  search: ['pattern', 'path'],
  web: ['url', 'query'],
  command: ['command'],
  task: ['description', 'prompt']
}

export function toolKindOf(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp'
  return KIND_BY_NAME[name] ?? 'other'
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

function editCounts(pairs: readonly { before: string; after: string }[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const { before, after } of pairs) {
    for (const row of replacementDiff(before, after)) {
      if (row.kind === 'add') added++
      else if (row.kind === 'del') removed++
    }
  }
  return { added, removed }
}

function editPairs(name: string, input: Record<string, unknown>): { before: string; after: string }[] {
  const pair = (fields: Record<string, unknown>): { before: string; after: string }[] =>
    typeof fields.old_string === 'string' && typeof fields.new_string === 'string' ? [{ before: fields.old_string, after: fields.new_string }] : []
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.flatMap((edit: unknown) => (edit !== null && typeof edit === 'object' ? pair(edit as Record<string, unknown>) : []))
  }
  return pair(input)
}

/** The daemon's summary, or one computed from the input for an event that predates it; a cut input may leave no target. */
export function summaryOf(item: Pick<ToolItem, 'name' | 'input' | 'summary'>): ToolSummary {
  if (item.summary) return item.summary
  const kind = toolKindOf(item.name)
  if (kind === 'mcp') {
    const [, server = '', ...tool] = item.name.split('__')
    return { kind, target: `${server} · ${tool.join('__')}`, added: null, removed: null }
  }
  const input = parseToolInput(item.input)
  const keys = TARGET_KEYS[kind]
  const named = keys?.map((key) => input?.[key]).find((value): value is string => typeof value === 'string' && value !== '')
  const target = named ?? (keys === undefined && item.input !== '' ? toolSummary(item.input) : '')
  if (input !== null && kind === 'edit') return { kind, target, ...editCounts(editPairs(item.name, input)) }
  if (input !== null && kind === 'write' && typeof input.content === 'string') return { kind, target, added: lineCount(input.content), removed: null }
  return { kind, target, added: null, removed: null }
}

const VERB: Record<ToolKind, string> = {
  read: 'Read',
  search: 'Searched',
  web: 'Fetched',
  command: 'Ran',
  edit: 'Edited',
  write: 'Wrote',
  todo: 'Updated todos',
  question: 'Asked',
  plan: 'Proposed a plan',
  task: 'Delegated',
  mcp: 'Called',
  other: ''
}

/** The row's verb: what the tool did, or its name when Houston has no verb for it. */
export function toolVerb(name: string, kind: ToolKind): string {
  if (name === 'WebSearch') return 'Searched the web'
  return VERB[kind] || name
}

/** A path under the session's directory, relative to it; any other target unchanged. */
export function displayTarget(target: string, cwd: string | undefined): string {
  if (!cwd) return target
  const base = cwd.replace(/[\\/]+$/, '')
  const sep = target.charAt(base.length)
  return target.length > base.length && target.startsWith(base) && (sep === '/' || sep === '\\') ? target.slice(base.length + 1) : target
}

/** `41s`, `2m 14s`, `1h 05m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Edits and writes that ran without an error, summed per file in first-touched order. */
export function changedFiles(items: readonly ThreadItem[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.result === null || item.result.isError) continue
    const summary = summaryOf(item)
    if ((summary.kind !== 'edit' && summary.kind !== 'write') || summary.target === '') continue
    const file = files.get(summary.target) ?? { path: summary.target, added: 0, removed: 0 }
    files.set(summary.target, { ...file, added: file.added + (summary.added ?? 0), removed: file.removed + (summary.removed ?? 0) })
  }
  return [...files.values()]
}

/** Counts of the turn's tool calls, most telling first. */
export function workCounts(items: readonly ThreadItem[], changed: number): string[] {
  const reads = new Set<string>()
  const count: Partial<Record<ToolKind, number>> = {}
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const summary = summaryOf(item)
    if (summary.kind === 'read') reads.add(summary.target)
    count[summary.kind] = (count[summary.kind] ?? 0) + 1
  }
  const parts: string[] = []
  if (reads.size > 0) parts.push(`Read ${plural(reads.size, 'file', 'files')}`)
  if (changed > 0) parts.push(`Changed ${plural(changed, 'file', 'files')}`)
  if (count.command) parts.push(`Ran ${plural(count.command, 'command', 'commands')}`)
  if (count.search) parts.push(plural(count.search, 'search', 'searches'))
  if (count.web) parts.push(plural(count.web, 'web request', 'web requests'))
  if (count.task) parts.push(plural(count.task, 'subagent', 'subagents'))
  if (count.mcp) parts.push(plural(count.mcp, 'MCP call', 'MCP calls'))
  return parts
}

const OUTCOME_VERB: Record<TurnOutcome, string> = { completed: 'Worked for', interrupted: 'Stopped after', error: 'Failed after' }

export function turnLabel(outcome: TurnOutcome, durationMs: number, counts: readonly string[]): string {
  return [`${OUTCOME_VERB[outcome]} ${formatDuration(durationMs)}`, ...counts].join(' · ')
}

/** Rows a folded turn still shows: a failed tool and a notice should not need a click to be seen. */
function staysVisible(item: ThreadItem): boolean {
  return item.kind === 'notice' || (item.kind === 'tool' && item.result?.isError === true)
}

/** A settled turn with work becomes a summary row; its work follows only when `expanded` names it. */
export function foldThreadRows(timeline: ThreadTimeline, expanded: ReadonlySet<string>): ThreadItem[] {
  const { items, turnOf, turns } = timeline
  const rows: ThreadItem[] = []
  let at = 0
  while (at < items.length) {
    const head = items[at]!
    const key = turnOf[at]
    const span = key == null ? undefined : turns.get(key)
    let end = at + 1
    while (end < items.length && turnOf[end] === key) end++
    if (head.kind !== 'user' || span === undefined || span.endMs === null || span.outcome === null) {
      rows.push(...items.slice(at, key == null ? at + 1 : end))
      at = key == null ? at + 1 : end
      continue
    }
    const body = items.slice(at + 1, end)
    let tail = body.length
    while (tail > 0 && (body[tail - 1]!.kind === 'stopped' || body[tail - 1]!.kind === 'error')) tail--
    const last = body[tail - 1]
    const answer = last?.kind === 'assistant' ? last : null
    const work = body.slice(0, answer ? tail - 1 : tail)
    const changed = changedFiles(work)
    rows.push(head)
    if (work.length > 0) {
      const open = expanded.has(span.key)
      rows.push({ kind: 'turn', key: `turn-${span.key}`, turn: span.key, label: turnLabel(span.outcome, span.endMs - span.startMs, workCounts(work, changed.length)), outcome: span.outcome, expanded: open })
      rows.push(...(open ? work : work.filter(staysVisible)))
    }
    if (answer) rows.push(answer)
    if (changed.length > 0) rows.push({ kind: 'changes', key: `changes-${span.key}`, files: changed })
    rows.push(...body.slice(tail))
    at = end
  }
  return rows
}
