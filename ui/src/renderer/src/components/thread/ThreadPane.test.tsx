// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HoustonClient, ServerMsg, SessionInfo } from '../../houston/client'
import { THREAD_HISTORY_PAGE } from '../../thread/threadStore'
import { THREAD_WINDOW_MAX, THREAD_WINDOW_PAGE } from '../../thread/threadModel'
import type { ThreadEvent, ThreadEventKind } from '../../thread/threadTypes'
import { loadMarkdownPipeline } from '../MarkdownPreview'
import { THREAD_STOPPED_COPY } from '../ui/Thread'
import { KEEP_PLANNING_DEFAULT, ThreadPane } from './ThreadPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The first import of the Markdown chunk is cold and slow while the whole suite runs in parallel.
const MARKDOWN_CHUNK_TIMEOUT_MS = 30_000

interface FakeClient {
  client: HoustonClient
  sent: { type: string; [key: string]: unknown }[]
  emit: (msg: object) => void
  setOpen: (open: boolean) => void
}

function fakeClient(): FakeClient {
  const listeners = new Set<(msg: ServerMsg) => void>()
  const sent: FakeClient['sent'] = []
  let open = true
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const listener = (msg: ServerMsg): void => { if (msg.type === kind) handler(msg) }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send: (msg: { type: string }) => { sent.push(msg) },
    trySend: (msg: { type: string }) => {
      if (!open) return false
      sent.push(msg)
      return true
    }
  } as unknown as HoustonClient
  return { client, sent, emit: (msg) => { for (const listener of [...listeners]) listener(msg as ServerMsg) }, setOpen: (value) => { open = value } }
}

function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 7, agent: 'claude', state: 'running', status: 'idle', view: 'thread', ...over } as unknown as SessionInfo
}

function ev(seq: number, kind: ThreadEventKind): ThreadEvent {
  return { seq, at_ms: seq, kind }
}

const user = (text: string): ThreadEventKind => ({ type: 'user_message', text })
const said = (id: string, text: string, truncated = false): ThreadEventKind => ({ type: 'assistant_message', message_id: id, text, truncated })
const delta = (id: string, text: string): ThreadEventKind => ({ type: 'assistant_delta', message_id: id, text })
const turnEnd = (outcome: 'completed' | 'interrupted' = 'completed'): ThreadEventKind => ({ type: 'turn_end', outcome, error: null })

describe('ThreadPane', () => {
  let container: HTMLDivElement
  let root: Root
  let fake: FakeClient

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fake = fakeClient()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const mount = (over: Partial<SessionInfo> = {}, connected = true): void => {
    act(() => {
      root.render(<ThreadPane client={fake.client} info={info(over)} connected={connected} />)
    })
  }
  const history = (events: ThreadEvent[], hasMore = false, beforeSeq: number | null = null): void => {
    act(() => fake.emit({ type: 'thread_history', session: 7, before_seq: beforeSeq, events, has_more: hasMore }))
  }
  const live = (events: ThreadEvent[]): void => {
    act(() => fake.emit({ type: 'thread_events', session: 7, events }))
  }
  const rows = (kind: string): string[] => [...container.querySelectorAll(`[data-thread-item="${kind}"]`)].map((row) => row.textContent ?? '')
  const input = (): HTMLTextAreaElement => container.querySelector('[data-testid="thread-composer-input"]')!
  const type = (text: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input(), text)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = (init: KeyboardEventInit): void => {
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init })) })
  }
  const sends = (): unknown[] => fake.sent.filter((msg) => msg.type === 'thread_send')
  const click = (testId: string): void => {
    act(() => (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click())
  }

  it('asks for the latest history page on attach and appends only newer live events', () => {
    mount()
    expect(fake.sent).toEqual([{ type: 'thread_history', session: 7, before_seq: null, limit: THREAD_HISTORY_PAGE }])
    live([ev(2, user('early live'))])
    history([ev(1, user('first')), ev(2, user('early live'))])
    live([ev(2, user('early live')), ev(3, user('next'))])
    act(() => fake.emit({ type: 'thread_events', session: 8, events: [ev(4, user('other session'))] }))
    expect(rows('user')).toEqual(['first', 'early live', 'next'])
  })

  it('shows one finished answer when its deltas arrive before a history page that already holds it', () => {
    mount()
    live([ev(2, delta('x', 'Hel')), ev(3, delta('x', 'lo')), ev(4, said('x', 'Hello.')), ev(5, turnEnd())])
    history([ev(1, user('hi')), ev(4, said('x', 'Hello.')), ev(5, turnEnd())])
    live([ev(6, delta('x', 'late'))])
    expect(rows('assistant')).toEqual(['Hello.'])
    expect(container.querySelector('[data-streaming]')).toBeNull()
  })

  it('folds a settled turn into its summary and opens it on click, while a live turn stays open', () => {
    mount({ cwd: '/repo' })
    const call = (id: string, name: string, input: object): ThreadEventKind => ({ type: 'tool_call', tool_use_id: id, name, input: JSON.stringify(input), truncated: false })
    const result = (id: string, isError = false): ThreadEventKind => ({ type: 'tool_result', tool_use_id: id, is_error: isError, output: 'out', truncated: false })
    history([
      { seq: 1, at_ms: 0, kind: user('fix it') },
      { seq: 2, at_ms: 10, kind: call('e', 'Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }) },
      { seq: 3, at_ms: 20, kind: result('e') },
      { seq: 4, at_ms: 30, kind: call('b', 'Bash', { command: 'false' }) },
      { seq: 5, at_ms: 40, kind: result('b', true) },
      { seq: 6, at_ms: 14_000, kind: said('m', 'Fixed.') },
      { seq: 7, at_ms: 14_000, kind: turnEnd() },
      { seq: 8, at_ms: 15_000, kind: user('again') },
      { seq: 9, at_ms: 15_100, kind: call('r', 'Read', { file_path: '/repo/src/a.ts' }) }
    ])
    expect(rows('turn')).toEqual(['Worked for 14s · Changed 1 file · Ran 1 command'])
    expect(rows('tool')).toEqual(['RanfalseFailed', 'Readsrc/a.tsRunning'])
    expect(rows('assistant')).toEqual(['Fixed.'])
    expect(rows('changes')[0]).toContain('src/a.ts')
    act(() => container.querySelector<HTMLButtonElement>('[data-thread-item="turn"] button')!.click())
    expect(rows('tool')).toHaveLength(3)
    expect(container.querySelector('[data-thread-item="turn"] button')!.getAttribute('aria-expanded')).toBe('true')
  })

  it('ignores a history reply that answers no request of this pane', () => {
    mount()
    history([ev(1, user('stale page'))], false, 999)
    expect(rows('user')).toEqual([])
    history([ev(1, user('mine'))])
    expect(rows('user')).toEqual(['mine'])
  })

  it('names a history request the connection dropped and retries it', () => {
    fake.setOpen(false)
    mount()
    expect(container.textContent).toContain('Thread history was not requested: the connection to the daemon is closed.')
    fake.setOpen(true)
    act(() => ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry') as HTMLButtonElement).click())
    expect(fake.sent).toEqual([{ type: 'thread_history', session: 7, before_seq: null, limit: THREAD_HISTORY_PAGE }])
    history([ev(1, user('back'))])
    expect(rows('user')).toEqual(['back'])
    expect(container.textContent).not.toContain('was not requested')
  })

  it('names a refused earlier page, and the retried page lands in its place', () => {
    mount()
    history([ev(10, user('ten'))], true)
    click('thread-show-earlier')
    act(() => fake.emit({ type: 'error', message: 'thread_history refused for session 7: limit 900 is outside 1..500', context: 'session:7' }))
    expect(container.textContent).toContain('thread_history refused for session 7')
    expect((container.querySelector('[data-testid="thread-show-earlier"]') as HTMLButtonElement).disabled).toBe(false)
    act(() => ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry') as HTMLButtonElement).click())
    history([ev(9, user('nine'))], false, 10)
    expect(rows('user')).toEqual(['nine', 'ten'])
    expect(container.textContent).not.toContain('refused')
  })

  it('sends on Enter, keeps Shift+Enter for a new line, and clears the field', () => {
    mount()
    history([])
    type('line one')
    press({ shiftKey: true })
    expect(sends()).toEqual([])
    press({})
    expect(sends()).toEqual([{ type: 'thread_send', session: 7, text: 'line one' }])
    expect(input().value).toBe('')
  })

  it('does not send on the Enter that confirms an IME candidate', () => {
    mount()
    history([])
    type('かな')
    press({ keyCode: 229 })
    press({ key: 'Process' })
    expect(sends()).toEqual([])
  })

  it('keeps the text and says so when the message could not be written', () => {
    mount()
    history([])
    type('keep me')
    fake.setOpen(false)
    press({})
    expect(input().value).toBe('keep me')
    expect(container.textContent).toContain('Message not sent: the connection to the daemon is closed. Your text is kept.')
  })

  it('refuses a message above the daemon limit, naming the exact sizes', () => {
    mount()
    history([])
    type('x'.repeat(256 * 1024 + 1))
    press({})
    expect(sends()).toEqual([])
    expect(container.textContent).toContain(`it is ${(262145).toLocaleString()} bytes and a thread message is limited to ${(262144).toLocaleString()} bytes`)
  })

  it('offers Stop while Claude works, starts up or waits for input, and while a turn has no end', () => {
    mount({ status: 'working' })
    click('thread-stop')
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_stop', session: 7 })
    for (const status of ['spawning', 'needs-input'] as const) {
      mount({ status })
      expect(container.querySelector('[data-testid="thread-stop"]')).not.toBeNull()
    }
    mount({ status: 'idle' })
    history([ev(1, user('go'))])
    expect(container.querySelector('[data-testid="thread-stop"]')).not.toBeNull()
    live([ev(2, turnEnd())])
    expect(container.querySelector('[data-testid="thread-stop"]')).toBeNull()
  })

  it('takes input only while the session runs, and names the state otherwise', () => {
    mount({ state: 'running', status: 'idle' })
    expect(input().disabled).toBe(false)
    for (const state of ['exited', 'interrupted', 'killed', 'sleeping'] as const) {
      mount({ state })
      expect(input().disabled).toBe(true)
      expect(input().placeholder).toBe(`This session is ${state}; restart it to continue`)
    }
  })

  it('disables the composer while disconnected', () => {
    mount({}, false)
    expect(fake.sent).toEqual([])
    expect(input().disabled).toBe(true)
    expect(input().placeholder).toBe('Reconnecting to the daemon')
  })

  it('answers a held permission request from its card and shows how it was resolved', () => {
    mount({ status: 'needs-input' })
    history([ev(1, { type: 'approval_request', request_id: 'r1', tool_use_id: 't1', tool_name: 'Bash', input: '{"command":"rm -rf build"}', truncated: false, input_bytes: 16 })])
    const card = (): HTMLElement => container.querySelector('[data-thread-item="approval"]')!
    expect(card().getAttribute('aria-label')).toBe('Permission request: Bash')
    expect(card().textContent).toContain('rm -rf build')
    const allow = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-testid="thread-approval-allow"]')!
    const deny = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-testid="thread-approval-deny"]')!
    expect(allow().tagName).toBe('BUTTON')
    act(() => deny().click())
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_approve', session: 7, request_id: 'r1', allow: false })
    expect(allow().disabled && deny().disabled).toBe(true)
    expect(card().textContent).toContain('Sending your answer')
    act(() => fake.emit({ type: 'error', message: 'thread_approve refused for session 7: no pending permission request "r1" (pending: [])', context: 'session:7' }))
    expect(allow().disabled).toBe(false)
    act(() => allow().click())
    expect(fake.sent.filter((msg) => msg.type === 'thread_approve')).toHaveLength(2)
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_approve', session: 7, request_id: 'r1', allow: true })
    act(() => fake.emit({ type: 'thread_events', session: 7, events: [ev(2, { type: 'approval_resolved', request_id: 'r1', decision: 'denied', reason: 'Stopped in Houston before anyone answered.' })] }))
    expect(card().dataset.approvalState).toBe('denied')
    expect(card().textContent).toContain('Denied · Stopped in Houston before anyone answered.')
    expect(container.querySelector('[data-testid="thread-approval-allow"]')).toBeNull()
  })

  it('keeps the card unanswerable while disconnected and names input it does not show', () => {
    mount({ status: 'needs-input' })
    history([ev(1, { type: 'approval_request', request_id: 'r1', tool_use_id: 't1', tool_name: 'Write', input: 'x'.repeat(1000), truncated: true, input_bytes: 1000 + 40 * 1024 })])
    const allow = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-testid="thread-approval-allow"]')!
    expect(allow().textContent).toBe('Allow (40 KiB not shown)')
    expect(container.textContent).toContain('40 KiB more input is not shown')
    mount({ status: 'needs-input' }, false)
    expect(allow().disabled).toBe(true)
  })

  it('asks a held question above the composer, sends the chosen answers and records them', () => {
    mount({ status: 'needs-input' })
    const questions = [
      { question: 'Which colour do you prefer?', header: 'Colour', multi_select: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] },
      { question: 'Which fruits?', header: 'Fruit', multi_select: true, options: [{ label: 'Plums', description: '' }, { label: 'Figs', description: '' }] }
    ]
    history([ev(1, user('Ask me')), ev(2, { type: 'question_request', request_id: 'q1', tool_use_id: 't1', questions, truncated: false })])
    const options = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="question-card-option"]')]
    const button = (testId: string): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
    expect(container.querySelector('[data-testid="question-card-pager"]')!.textContent).toContain('1 of 2 › · Colour')
    expect(rows('question')[0]).toContain('Waiting for your answer below')
    expect(button('question-card-next').disabled).toBe(true)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' })) })
    expect(options()[1]!.getAttribute('aria-pressed')).toBe('true')
    type('3')
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })) })
    expect(options()[0]!.getAttribute('aria-pressed')).toBe('false')
    click('question-card-next')
    expect(button('question-card-submit').disabled).toBe(true)
    act(() => options()[0]!.click())
    act(() => options()[1]!.click())
    click('question-card-escape-hatch')
    const freeText = container.querySelector<HTMLTextAreaElement>('[data-testid="question-card-freetext"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(freeText, '  pears ')
      freeText.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click('question-card-submit')
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_answer', session: 7, request_id: 'q1', answers: [
      { question: 'Which colour do you prefer?', selected: ['Blue'], other: null },
      { question: 'Which fruits?', selected: ['Plums', 'Figs'], other: 'pears' }
    ] })
    expect(button('question-card-skip').disabled).toBe(true)
    act(() => fake.emit({ type: 'error', message: 'thread_answer refused for session 7: no held question "q1"', context: 'session:7' }))
    expect(button('question-card-skip').disabled).toBe(false)
    click('question-card-skip')
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_answer', session: 7, request_id: 'q1', answers: null })
    live([ev(3, { type: 'question_resolved', request_id: 'q1', outcome: 'answered', answers: [
      { question: 'Which colour do you prefer?', selected: ['Blue'], other: null },
      { question: 'Which fruits?', selected: ['Plums', 'Figs'], other: 'pears' }
    ], reason: null })])
    expect(container.querySelector('[data-testid="thread-question-dock"]')).toBeNull()
    expect(rows('question')[0]).toContain('Answered')
    expect(rows('question')[0]).toContain('Plums, Figs, pears')
    live([ev(4, turnEnd())])
    expect(rows('question')).toHaveLength(1)
  })

  it('implements a plan, or keeps planning with the message box text as the reason', () => {
    mount({ status: 'needs-input' })
    const plan = JSON.stringify({ plan: 'Make the rail sort stable.', planFilePath: '/home/dev/.claude/plans/p.md' })
    history([
      ev(1, user('Plan it')),
      ev(2, { type: 'approval_request', request_id: 'p1', tool_use_id: 't1', tool_name: 'ExitPlanMode', input: plan, truncated: false, input_bytes: plan.length }),
      ev(3, { type: 'approval_request', request_id: 'p2', tool_use_id: 't2', tool_name: 'ExitPlanMode', input: '{"plan":"Cut', truncated: true, input_bytes: 70_000 })
    ])
    const cards = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-thread-item="plan"]')]
    expect(container.querySelector('[data-thread-item="approval"]')).toBeNull()
    expect(cards()[0]!.textContent).toContain('Make the rail sort stable.')
    expect(cards()[0]!.textContent).not.toContain('planFilePath')
    expect(cards()[1]!.textContent).toContain('The plan was cut at 64 KiB by Houston')
    type('Split the second step.')
    act(() => cards()[0]!.querySelector<HTMLButtonElement>('[data-testid="thread-plan-keep"]')!.click())
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_approve', session: 7, request_id: 'p1', allow: false, message: 'Split the second step.' })
    expect(input().value).toBe('')
    act(() => cards()[1]!.querySelector<HTMLButtonElement>('[data-testid="thread-plan-keep"]')!.click())
    expect(fake.sent.at(-1)).toMatchObject({ request_id: 'p2', allow: false, message: KEEP_PLANNING_DEFAULT })
    act(() => fake.emit({ type: 'error', message: 'thread_approve refused for session 7: no pending permission request "p2" (pending: ["p1"])', context: 'session:7' }))
    act(() => cards()[1]!.querySelector<HTMLButtonElement>('[data-testid="thread-plan-implement"]')!.click())
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_approve', session: 7, request_id: 'p2', allow: true })
    live([ev(4, { type: 'approval_resolved', request_id: 'p1', decision: 'denied', reason: 'Split the second step.' }), ev(5, turnEnd())])
    expect(cards()[0]!.textContent).toContain('Kept planning · Split the second step.')
  })

  it('locks the permission mode while a turn is open even before the status says so', () => {
    mount({ status: 'idle' })
    history([ev(1, user('go'))])
    const select = (): HTMLButtonElement => container.querySelector('[data-testid="thread-permission-mode"]')!
    expect(select().disabled).toBe(true)
    act(() => fake.emit({ type: 'thread_events', session: 7, events: [ev(2, { type: 'turn_end', outcome: 'completed', error: null })] }))
    expect(select().disabled).toBe(false)
  })

  it('shows the permission mode and locks it while a turn runs, naming the status', () => {
    mount({ status: 'working' })
    const select = (): HTMLButtonElement => container.querySelector('[data-testid="thread-permission-mode"]')!
    expect(select().textContent).toContain('Ask before tools')
    expect(select().disabled).toBe(true)
    act(() => {
      root.render(<ThreadPane client={fake.client} info={info({ status: 'idle', permission_mode: 'accept_edits' })} connected />)
    })
    expect(select().textContent).toContain('Accept edits')
    expect(select().disabled).toBe(false)
  })

  it('marks a stopped turn as not remembered without calling its stored partial answer cut', () => {
    mount()
    history([ev(1, user('go')), ev(2, said('p', 'partial', true)), ev(3, turnEnd('interrupted'))])
    expect(container.textContent).toContain(THREAD_STOPPED_COPY)
    expect(container.textContent).not.toContain('Answer cut at')
  })

  it('never loads a remote image from an answer until asked', async () => {
    await act(async () => { await loadMarkdownPipeline() })
    mount()
    history([ev(1, said('i', 'See ![chart](https://example.com/leak?d=secret) and <img src="https://example.com/raw">'))])
    await act(async () => { await loadMarkdownPipeline() })
    expect(container.querySelector('[data-testid="thread-markdown-body"]')).not.toBeNull()
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.textContent).toContain('https://example.com/leak?d=secret')
    act(() => (container.querySelector('[data-testid="thread-image-load"]') as HTMLButtonElement).click())
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toContain('https://example.com/leak?d=secret')
  }, MARKDOWN_CHUNK_TIMEOUT_MS)

  it('keeps an earlier page and the window on it while live events stream in', () => {
    mount()
    history(Array.from({ length: 1000 }, (_, i) => ev(i + 1001, user(`m${i + 1001}`))), true)
    for (let i = 0; i < 6; i++) click('thread-show-earlier')
    history(Array.from({ length: 200 }, (_, i) => ev(i + 801, user(`m${i + 801}`))), true, 1001)
    const before = rows('user')
    expect(before).toContain('m1000')
    live(Array.from({ length: 300 }, (_, i) => ev(i + 2001, user(`live${i}`))))
    expect(rows('user')).toEqual(before)
    click('thread-jump-latest')
    expect(rows('user').at(-1)).toBe('live299')
  })

  it('renders a bounded window of a long history and shows an earlier page in the click that loads it', () => {
    mount()
    history(Array.from({ length: 1000 }, (_, i) => ev(i + 1001, user(`m${i + 1001}`))), true)
    expect(rows('user')).toHaveLength(THREAD_WINDOW_PAGE)
    expect(rows('user').at(-1)).toBe('m2000')
    for (let i = 0; i < 10; i++) click('thread-show-earlier')
    expect(rows('user')).toHaveLength(THREAD_WINDOW_MAX)
    expect(rows('user')[0]).toBe('m1001')
    expect(fake.sent.filter((msg) => msg.type === 'thread_history' && msg.before_seq === 1001)).toHaveLength(1)
    history(Array.from({ length: 200 }, (_, i) => ev(i + 801, user(`m${i + 801}`))), true, 1001)
    expect(rows('user')).toHaveLength(THREAD_WINDOW_MAX)
    expect(rows('user')).toContain('m1000')
    expect(container.querySelector('[data-testid="thread-jump-latest"]')).not.toBeNull()
  })
})
