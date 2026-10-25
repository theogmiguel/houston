import { describe, expect, it } from 'vitest'
import { buildThreadTimeline, type ThreadItem } from './threadModel'
import { changedFiles, displayTarget, foldThreadRows, formatDuration, summaryOf, toolKindOf } from './threadTurns'
import type { ThreadEvent, ThreadEventKind, ToolSummary } from './threadTypes'

const user = (text: string): ThreadEventKind => ({ type: 'user_message', text })
const said = (id: string, text: string): ThreadEventKind => ({ type: 'assistant_message', message_id: id, text, truncated: false })
const call = (id: string, name: string, input: object, summary?: ToolSummary): ThreadEventKind => ({ type: 'tool_call', tool_use_id: id, name, input: JSON.stringify(input), truncated: false, summary })
const result = (id: string, isError = false): ThreadEventKind => ({ type: 'tool_result', tool_use_id: id, is_error: isError, output: isError ? 'boom' : 'ok', truncated: false })
const end = (outcome: 'completed' | 'interrupted' | 'error' = 'completed'): ThreadEventKind => ({ type: 'turn_end', outcome, error: outcome === 'error' ? 'provider error' : null })

/** Events at the given offsets in milliseconds; seq starts at `first`. */
function timed(entries: [number, ThreadEventKind][], first = 1): ThreadEvent[] {
  return entries.map(([at, kind], i) => ({ seq: first + i, at_ms: at, kind }))
}

const kinds = (rows: readonly ThreadItem[]): string[] => rows.map((row) => row.kind === 'turn' ? `turn:${row.label}` : row.kind)

const WORKED: [number, ThreadEventKind][] = [
  [0, user('Rename the helper')],
  [1000, call('r1', 'Read', { file_path: '/repo/src/a.ts' })],
  [2000, result('r1')],
  [3000, call('r2', 'Read', { file_path: '/repo/src/a.ts' })],
  [3500, result('r2')],
  [4000, call('e1', 'Edit', { file_path: '/repo/src/a.ts', old_string: 'old()\n', new_string: 'renamed()\n' })],
  [5000, result('e1')],
  [6000, call('b1', 'Bash', { command: 'false' })],
  [7000, result('b1', true)],
  [8000, call('w1', 'Write', { file_path: '/repo/src/b.ts', content: 'one\ntwo\n' })],
  [9000, result('w1')],
  [134_000, said('m1', 'Renamed.')],
  [134_000, end()]
]

describe('foldThreadRows', () => {
  it('folds a settled turn behind its summary, keeping the answer, the failed call and the changed files out', () => {
    const rows = foldThreadRows(buildThreadTimeline(timed(WORKED)), new Set())
    expect(kinds(rows)).toEqual(['user', 'turn:Worked for 2m 14s · Read 1 file · Changed 2 files · Ran 1 command', 'tool', 'assistant', 'changes'])
    expect(rows[2]).toMatchObject({ kind: 'tool', name: 'Bash' })
    expect(rows[4]).toEqual({ kind: 'changes', key: 'changes-1', files: [{ path: '/repo/src/a.ts', added: 1, removed: 1 }, { path: '/repo/src/b.ts', added: 2, removed: 0 }] })
  })

  it('shows the work in order when the reader opens the turn, keyed by the seq of its first message', () => {
    const timeline = buildThreadTimeline(timed(WORKED, 40))
    const rows = foldThreadRows(timeline, new Set(['40']))
    expect(rows[1]).toMatchObject({ kind: 'turn', key: 'turn-40', turn: '40', expanded: true })
    expect(kinds(rows).slice(2)).toEqual(['tool', 'tool', 'tool', 'tool', 'tool', 'assistant', 'changes'])
  })

  it('keeps the open turn expanded and does not fold a turn without work', () => {
    const rows = foldThreadRows(buildThreadTimeline(timed([
      [0, user('hi')], [500, said('m0', 'Hello.')], [500, end()],
      [1000, user('Read it')], [1100, call('r1', 'Read', { file_path: 'a.ts' })]
    ])), new Set())
    expect(kinds(rows)).toEqual(['user', 'assistant', 'user', 'tool'])
  })

  it('names a stopped and a failed turn, and keeps their end rows visible', () => {
    const stopped = foldThreadRows(buildThreadTimeline(timed([[0, user('go')], [1000, call('b', 'Bash', { command: 'sleep 60' })], [41_000, end('interrupted')]])), new Set())
    expect(kinds(stopped)).toEqual(['user', 'turn:Stopped after 41s · Ran 1 command', 'stopped'])
    const failed = foldThreadRows(buildThreadTimeline(timed([[0, user('go')], [1000, call('g', 'Grep', { pattern: 'x' })], [1500, result('g')], [182_000, end('error')]])), new Set())
    expect(kinds(failed)).toEqual(['user', 'turn:Failed after 3m 02s · 1 search', 'error'])
  })

  it('leaves rows before the first loaded user message as they are', () => {
    const rows = foldThreadRows(buildThreadTimeline(timed([[0, call('t', 'Read', { file_path: 'a' })], [1, result('t')], [2, end()], [3, user('next')]])), new Set())
    expect(kinds(rows)).toEqual(['tool', 'user'])
  })
})

describe('summaryOf', () => {
  it('prefers the daemon summary, which survives an input cut at the cap', () => {
    const daemon: ToolSummary = { kind: 'edit', target: '/repo/big.ts', added: 300, removed: 280 }
    expect(summaryOf({ name: 'Edit', input: '{"file_path":"/repo/big.ts","old_string":"aaa', summary: daemon })).toBe(daemon)
    expect(summaryOf({ name: 'Edit', input: '{"file_path":"/repo/big.ts","old_string":"aaa', summary: null })).toEqual({ kind: 'edit', target: '', added: null, removed: null })
  })

  it('maps tool names like the daemon table for events stored before summaries', () => {
    expect(['Read', 'Glob', 'WebSearch', 'PowerShell', 'NotebookEdit', 'Write', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'Task', 'mcp__houston__pane_wait', 'Skill'].map(toolKindOf))
      .toEqual(['read', 'search', 'web', 'command', 'edit', 'write', 'todo', 'question', 'plan', 'task', 'mcp', 'other'])
    expect(summaryOf({ name: 'mcp__houston__pane_wait', input: '{}', summary: null }).target).toBe('houston · pane_wait')
    expect(summaryOf({ name: 'MultiEdit', input: JSON.stringify({ file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'c' }] }), summary: null }))
      .toEqual({ kind: 'edit', target: 'a.ts', added: 1, removed: 2 })
  })
})

describe('changedFiles', () => {
  it('sums edits per file and skips failed or unanswered calls', () => {
    const { items } = buildThreadTimeline(timed([
      [0, call('a', 'Edit', {}, { kind: 'edit', target: 'x.ts', added: 2, removed: 1 })], [1, result('a')],
      [2, call('b', 'Edit', {}, { kind: 'edit', target: 'x.ts', added: 3, removed: 0 })], [3, result('b')],
      [4, call('c', 'Edit', {}, { kind: 'edit', target: 'y.ts', added: 9, removed: 9 })], [5, result('c', true)],
      [6, call('d', 'Write', {}, { kind: 'write', target: 'z.ts', added: 4 })]
    ]))
    expect(changedFiles(items)).toEqual([{ path: 'x.ts', added: 5, removed: 1 }])
  })
})

describe('formatting', () => {
  it('formats durations and shortens paths under the session directory', () => {
    expect([200, 41_000, 134_000, 3_900_000].map(formatDuration)).toEqual(['1s', '41s', '2m 14s', '1h 05m'])
    expect(displayTarget('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(displayTarget('/repository/a.ts', '/repo')).toBe('/repository/a.ts')
    expect(displayTarget('C:\\repo\\a.ts', 'C:\\repo\\')).toBe('a.ts')
  })
})
