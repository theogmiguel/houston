import { describe, expect, it } from 'vitest'
import {
  LATEST_WINDOW,
  THREAD_WINDOW_MAX,
  THREAD_WINDOW_PAGE,
  buildThreadItems,
  replacementDiff,
  sameThreadItem,
  showEarlier,
  showLater,
  toolSummary,
  turnOpen,
  windowBounds,
  type ThreadItem
} from './threadModel'
import type { ThreadEvent, ThreadEventKind } from './threadTypes'

function events(kinds: ThreadEventKind[]): ThreadEvent[] {
  return kinds.map((kind, i) => ({ seq: i + 1, at_ms: i, kind }))
}

const delta = (id: string, text: string): ThreadEventKind => ({ type: 'assistant_delta', message_id: id, text })

describe('buildThreadItems', () => {
  it('folds a permission request and its resolution into one approval row', () => {
    const items = buildThreadItems(events([
      { type: 'tool_call', tool_use_id: 't1', name: 'Bash', input: '{"command":"ls"}', truncated: false },
      { type: 'approval_request', request_id: 'r1', tool_use_id: 't1', tool_name: 'Bash', input: '{"command":"ls"}', truncated: false },
      { type: 'approval_request', request_id: 'r2', tool_use_id: 't2', tool_name: 'Write', input: '{}', truncated: true },
      { type: 'approval_resolved', request_id: 'r1', decision: 'denied', reason: 'not now' },
      { type: 'approval_resolved', request_id: 'unknown', decision: 'allowed', reason: null }
    ]))
    expect(items.slice(1)).toEqual([
      { kind: 'approval', key: '2', requestId: 'r1', name: 'Bash', input: '{"command":"ls"}', inputTruncated: false, state: 'denied', reason: 'not now' },
      { kind: 'approval', key: '3', requestId: 'r2', name: 'Write', input: '{}', inputTruncated: true, state: 'pending', reason: null }
    ])
    expect(sameThreadItem(items[1]!, { ...items[1]!, state: 'allowed' } as ThreadItem)).toBe(false)
  })

  it('appends live deltas to one streaming block per message', () => {
    const items = buildThreadItems(events([{ type: 'user_message', text: 'hi' }, delta('m1', 'Hel'), delta('m1', 'lo')]))
    expect(items).toEqual([
      { kind: 'user', key: '1', text: 'hi' },
      { kind: 'assistant', key: 'delta-2', text: 'Hello', streaming: true, truncated: false }
    ])
  })

  it('replaces streamed deltas with the stored message', () => {
    const items = buildThreadItems(events([delta('m1', 'Hel'), { type: 'assistant_message', message_id: 'm1', text: 'Hello.', truncated: true }]))
    expect(items).toEqual([{ kind: 'assistant', key: '2', text: 'Hello.', streaming: false, truncated: true }])
  })

  it('freezes a partial answer and marks the turn stopped when it is interrupted', () => {
    const items = buildThreadItems(events([delta('m1', 'Half an'), { type: 'turn_end', outcome: 'interrupted', error: null }]))
    expect(items).toEqual([
      { kind: 'assistant', key: 'delta-1', text: 'Half an', streaming: false, truncated: false },
      { kind: 'stopped', key: '2' }
    ])
  })

  it('attaches a tool result to its call and settles calls left without one', () => {
    const items = buildThreadItems(events([
      { type: 'tool_call', tool_use_id: 'a', name: 'Bash', input: '{"command":"ls"}', truncated: false },
      { type: 'tool_result', tool_use_id: 'a', is_error: false, output: 'x', truncated: true },
      { type: 'tool_call', tool_use_id: 'b', name: 'Read', input: '{}', truncated: false },
      { type: 'turn_end', outcome: 'completed', error: null }
    ]))
    expect(items).toEqual([
      { kind: 'tool', key: '1', name: 'Bash', input: '{"command":"ls"}', inputTruncated: false, result: { isError: false, output: 'x', truncated: true }, settled: false },
      { kind: 'tool', key: '3', name: 'Read', input: '{}', inputTruncated: false, result: null, settled: true }
    ])
  })

  it('keeps a result whose call is on an earlier, unloaded page', () => {
    const items = buildThreadItems(events([{ type: 'tool_result', tool_use_id: 'gone', is_error: true, output: 'boom', truncated: false }]))
    expect(items[0]).toMatchObject({ kind: 'tool', name: 'Tool result', result: { isError: true, output: 'boom' } })
  })

  it('shows an errored turn with its error text', () => {
    const items = buildThreadItems(events([{ type: 'turn_end', outcome: 'error', error: 'rate limited' }]))
    expect(items).toEqual([{ kind: 'error', key: '1', text: 'rate limited' }])
  })

  it('treats rebuilt rows with the same content as unchanged', () => {
    const list = events([{ type: 'user_message', text: 'a' }, delta('m', 'b')])
    const [a1, b1] = buildThreadItems(list)
    const [a2, b2] = buildThreadItems([...list])
    expect(sameThreadItem(a1!, a2!)).toBe(true)
    expect(sameThreadItem(b1!, b2!)).toBe(true)
    const [, b3] = buildThreadItems([...list, { seq: 3, at_ms: 3, kind: delta('m', 'c') }])
    expect(sameThreadItem(b1!, b3!)).toBe(false)
  })
})

describe('stale deltas and open turns', () => {
  it('skips deltas for a message already stored earlier in the log', () => {
    const items = buildThreadItems(events([
      { type: 'assistant_message', message_id: 'x', text: 'Hello.', truncated: false },
      { type: 'turn_end', outcome: 'completed', error: null },
      delta('x', 'late')
    ]))
    expect(items).toEqual([{ kind: 'assistant', key: '1', text: 'Hello.', streaming: false, truncated: false }])
  })

  it('reports a turn as open from its user message until its turn end', () => {
    expect(turnOpen(events([]))).toBe(false)
    expect(turnOpen(events([{ type: 'user_message', text: 'go' }, delta('m', 'a')]))).toBe(true)
    expect(turnOpen(events([{ type: 'user_message', text: 'go' }, { type: 'turn_end', outcome: 'interrupted', error: null }]))).toBe(false)
  })
})

describe('row window', () => {
  const items: ThreadItem[] = Array.from({ length: 1000 }, (_, i) => ({ kind: 'notice', key: String(i), text: '' }))

  it('renders the newest page by default', () => {
    expect(windowBounds(items, LATEST_WINDOW)).toEqual({ start: 1000 - THREAD_WINDOW_PAGE, end: 1000 })
  })

  it('grows to the cap, then slides, never rendering more than the cap', () => {
    let win = LATEST_WINDOW
    for (let i = 0; i < 20; i++) {
      win = showEarlier(items, win)
      const { start, end } = windowBounds(items, win)
      expect(end - start).toBeLessThanOrEqual(THREAD_WINDOW_MAX)
    }
    expect(windowBounds(items, win).start).toBe(0)
  })

  it('returns to following the newest row after showing later pages', () => {
    let win = LATEST_WINDOW
    for (let i = 0; i < 10; i++) win = showEarlier(items, win)
    expect(win.end).not.toBeNull()
    for (let i = 0; i < 10 && win.end !== null; i++) win = showLater(items, win)
    expect(win.end).toBeNull()
  })
})

describe('tool presentation', () => {
  it('diffs only the changed lines with surrounding context', () => {
    expect(replacementDiff('a\nb\nc\nd', 'a\nB\nc\nd')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'ctx', text: 'c' },
      { kind: 'ctx', text: 'd' }
    ])
  })

  it('summarises a call by the field it acts on, and falls back to the raw text', () => {
    expect(toolSummary('{"description":"x","command":"ls -la"}')).toBe('ls -la')
    expect(toolSummary('{"file_path":"src/a.ts","old_string":"x"}')).toBe('src/a.ts')
    expect(toolSummary('{"command":"cut at the cap')).toBe('{"command":"cut at the cap')
  })
})
