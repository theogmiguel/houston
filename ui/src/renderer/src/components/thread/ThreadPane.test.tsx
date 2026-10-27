// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, ServerMsg, SessionInfo } from '../../houston/client'
import { APPROVAL_MESSAGE_MAX_BYTES } from '../../houston/generated/DEFAULTS'
import { THREAD_HISTORY_PAGE } from '../../thread/threadStore'
import { THREAD_WINDOW_MAX, THREAD_WINDOW_PAGE } from '../../thread/threadModel'
import type { ThreadEvent, ThreadEventKind, ThreadQueuedMessage } from '../../thread/threadTypes'
import { loadMarkdownPipeline } from '../MarkdownPreview'
import { THREAD_STOPPED_COPY } from '../ui/Thread'
import { KEEP_PLANNING_DEFAULT, ThreadPane, composerIntent, queueSummary } from './ThreadPane'
import { registerTerminalSelection } from '../../pane/terminalSelection'

const search = vi.hoisted(() => vi.fn())
vi.mock('../../houston/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../houston/bridge')>()
  return { ...actual, searchFilePaths: search }
})

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

const user = (text: string): ThreadEventKind => ({ type: 'user_message', delivery: 'direct', text, excerpts: [] })
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
      root.render(<ThreadPane client={fake.client} info={info(over)} connected={connected} active />)
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
    expect(fake.sent).toEqual([{ type: 'thread_queue_list', session: 7 }, { type: 'thread_commands_list', session: 7 }, { type: 'thread_history', session: 7, before_seq: null, limit: THREAD_HISTORY_PAGE }])
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
    expect(fake.sent).toEqual([{ type: 'thread_queue_list', session: 7 }, { type: 'thread_commands_list', session: 7 }, { type: 'thread_history', session: 7, before_seq: null, limit: THREAD_HISTORY_PAGE }])
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
    expect(sends()).toEqual([{ type: 'thread_send', session: 7, text: 'line one', steer: false, excerpts: [] }])
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

  it('gives a number key only to the question of the focused pane', () => {
    const second = document.createElement('div')
    document.body.appendChild(second)
    const other = createRoot(second)
    const questions = [{ question: 'Which colour?', header: '', multi_select: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }]
    act(() => {
      root.render(<ThreadPane client={fake.client} info={info({ status: 'needs-input' })} connected active />)
      other.render(<ThreadPane client={fake.client} info={info({ id: 8, status: 'needs-input' })} connected active={false} />)
    })
    for (const session of [7, 8]) {
      act(() => fake.emit({ type: 'thread_history', session, before_seq: null, events: [ev(1, { type: 'question_request', request_id: `q${session}`, tool_use_id: 't', questions, truncated: false })], has_more: false }))
    }
    const pressed = (host: HTMLElement): (string | null)[] => [...host.querySelectorAll('[data-testid="question-card-option"]')].map((option) => option.getAttribute('aria-pressed'))
    const key = (k: string): void => { act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })) }) }
    key('1')
    expect(pressed(container)).toEqual(['true', 'false'])
    expect(pressed(second)).toEqual(['false', 'false'])
    act(() => second.querySelector<HTMLButtonElement>('[data-testid="question-card-skip"]')!.focus())
    key('2')
    expect(pressed(container)).toEqual(['true', 'false'])
    expect(pressed(second)).toEqual(['false', 'true'])
    act(() => other.unmount())
    second.remove()
  })

  it('takes no number keys while the grid is hidden, a dialog holds focus or focus is outside the grid', () => {
    const slot = document.createElement('div')
    slot.className = 'grid-slot'
    document.body.appendChild(slot)
    const slotRoot = createRoot(slot)
    const questions = [{ question: 'Which colour?', header: '', multi_select: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }]
    act(() => slotRoot.render(<ThreadPane client={fake.client} info={info({ status: 'needs-input' })} connected active />))
    history([ev(1, { type: 'question_request', request_id: 'q7', tool_use_id: 't', questions, truncated: false })])
    const pressed = (): (string | null)[] => [...slot.querySelectorAll('[data-testid="question-card-option"]')].map((option) => option.getAttribute('aria-pressed'))
    const key = (k: string): void => { act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })) }) }
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inDialog = document.createElement('button')
    dialog.appendChild(inDialog)
    const outside = document.createElement('button')
    document.body.append(dialog, outside)
    act(() => inDialog.focus())
    key('1')
    act(() => outside.focus())
    key('1')
    act(() => outside.blur())
    slot.setAttribute('inert', '')
    key('1')
    expect(pressed()).toEqual(['false', 'false'])
    slot.removeAttribute('inert')
    key('1')
    expect(pressed()).toEqual(['true', 'false'])
    act(() => slotRoot.unmount())
    slot.remove()
    dialog.remove()
    outside.remove()
  })

  it('refuses Keep planning feedback over the limit by name and keeps the text', () => {
    mount({ status: 'needs-input' })
    const plan = JSON.stringify({ plan: 'Make the rail sort stable.' })
    history([ev(1, user('Plan it')), ev(2, { type: 'approval_request', request_id: 'p1', tool_use_id: 't1', tool_name: 'ExitPlanMode', input: plan, truncated: false, input_bytes: plan.length })])
    const long = 'x'.repeat(APPROVAL_MESSAGE_MAX_BYTES + 1)
    type(long)
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="thread-plan-keep"]')!.click())
    expect(fake.sent.filter((msg) => msg.type === 'thread_approve')).toEqual([])
    expect(input().value).toBe(long)
    expect(container.textContent).toContain(`it is ${(APPROVAL_MESSAGE_MAX_BYTES + 1).toLocaleString()} bytes and Keep planning takes up to ${APPROVAL_MESSAGE_MAX_BYTES.toLocaleString()} bytes`)
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

  describe('queue', () => {
    const queued = (id: string, text: string, state: 'queued' | 'held' = 'queued', reason: string | null = null): ThreadQueuedMessage =>
      ({ id, text, state, hold_reason: reason, created_at_ms: 1, excerpts: [] })
    const snapshot = (items: ThreadQueuedMessage[]): void => {
      act(() => fake.emit({ type: 'thread_queue', session: 7, items }))
    }
    const last = (): unknown => fake.sent.at(-1)

    it('queues on Enter and steers on Ctrl+Enter while a turn is open, and offers Stop only with an empty field', () => {
      mount({ status: 'working' })
      history([ev(1, user('go'))])
      expect(container.querySelector('[data-testid="thread-stop"]')).not.toBeNull()
      type('next')
      expect(container.querySelector('[data-testid="thread-stop"]')).toBeNull()
      expect(container.textContent).toContain('Enter queues · Ctrl+Enter steers')
      press({})
      expect(last()).toEqual({ type: 'thread_send', session: 7, text: 'next', steer: false, excerpts: [] })
      type('now')
      press({ ctrlKey: true })
      expect(last()).toEqual({ type: 'thread_send', session: 7, text: 'now', steer: true, excerpts: [] })
      type('by button')
      click('thread-steer')
      expect(last()).toEqual({ type: 'thread_send', session: 7, text: 'by button', steer: true, excerpts: [] })
      type('queued by button')
      click('thread-queue')
      expect(last()).toEqual({ type: 'thread_send', session: 7, text: 'queued by button', steer: false, excerpts: [] })
    })

    it('never steers when no turn is open', () => {
      expect(composerIntent(false, true)).toBe('send')
      expect(composerIntent(true, false)).toBe('queue')
      expect(composerIntent(true, true)).toBe('steer')
    })

    it('lists waiting messages under the timeline and acts on one', () => {
      mount({ status: 'working' })
      history([ev(1, user('go'))])
      snapshot([queued('q1', 'first'), queued('q2', 'second')])
      expect(rows('queued').map((row) => row.includes('Queued'))).toEqual([true, true])
      expect(container.querySelector('[data-testid="thread-queue-strip"]')?.textContent).toContain('Queued 2')
      act(() => (container.querySelectorAll('[data-testid="thread-queued-steer"]')[1] as HTMLButtonElement).click())
      expect(last()).toEqual({ type: 'thread_steer', session: 7, id: 'q2' })
      act(() => (container.querySelector('[data-testid="thread-queued-remove"]') as HTMLButtonElement).click())
      expect(last()).toEqual({ type: 'thread_queue_remove', session: 7, id: 'q1' })
      click('thread-queue-steer')
      expect(last()).toEqual({ type: 'thread_steer', session: 7, id: 'q1' })
      click('thread-queue-clear')
      expect(fake.sent.slice(-2)).toEqual([{ type: 'thread_queue_remove', session: 7, id: 'q1' }, { type: 'thread_queue_remove', session: 7, id: 'q2' }])
      snapshot([])
      expect(rows('queued')).toEqual([])
      expect(container.querySelector('[data-testid="thread-queue-strip"]')).toBeNull()
    })

    it('edits a waiting message in place and keeps the text when Escape cancels', () => {
      mount({ status: 'working' })
      history([ev(1, user('go'))])
      snapshot([queued('q1', 'first')])
      click('thread-queued-edit')
      const field = (): HTMLTextAreaElement => container.querySelector('[data-testid="thread-queued-input"]')!
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      act(() => { setter.call(field(), 'FIRST'); field().dispatchEvent(new Event('input', { bubbles: true })) })
      act(() => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(container.querySelector('[data-testid="thread-queued-input"]')).toBeNull()
      expect(fake.sent.some((msg) => msg.type === 'thread_queue_edit')).toBe(false)
      click('thread-queued-edit')
      act(() => { setter.call(field(), 'FIRST'); field().dispatchEvent(new Event('input', { bubbles: true })) })
      act(() => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      expect(last()).toEqual({ type: 'thread_queue_edit', session: 7, id: 'q1', text: 'FIRST' })
    })

    it('says why held messages wait and sends one only when asked', () => {
      mount()
      history([ev(1, user('go')), ev(2, turnEnd('interrupted'))])
      snapshot([queued('q1', 'first', 'held', 'Houston restarted before this message was sent.'), queued('q2', 'second')])
      const strip = container.querySelector('[data-testid="thread-queue-strip"]')?.textContent ?? ''
      expect(strip).toContain('Held 1')
      expect(strip).toContain('Houston restarted before this message was sent. · 1 queued')
      expect(rows('queued')[0]).toContain('Houston restarted before this message was sent.')
      expect(fake.sent.some((msg) => msg.type === 'thread_queue_send')).toBe(false)
      click('thread-queue-send-next')
      expect(last()).toEqual({ type: 'thread_queue_send', session: 7, id: 'q1' })
      act(() => (container.querySelector('[data-testid="thread-queued-send"]') as HTMLButtonElement).click())
      expect(last()).toEqual({ type: 'thread_queue_send', session: 7, id: 'q1' })
    })

    it('shows the daemon refusing a queued message until dismissed', () => {
      mount({ status: 'working' })
      history([ev(1, user('go'))])
      act(() => fake.emit({ type: 'error', message: 'thread_send refused for session 7: the queue holds 16 messages, the limit (THREAD_QUEUE_MAX_ITEMS) is 16; send or remove one to queue a message', context: 'session:7' }))
      expect(container.textContent).toContain('the limit (THREAD_QUEUE_MAX_ITEMS) is 16')
      act(() => ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss') as HTMLButtonElement).click())
      expect(container.textContent).not.toContain('THREAD_QUEUE_MAX_ITEMS')
    })

    it('marks a steered message', () => {
      mount()
      history([ev(1, { type: 'user_message', delivery: 'steered', text: 'first', excerpts: [] }), ev(2, user('plain'))])
      expect([...container.querySelectorAll('[data-thread-item="user"]')].map((row) => row.hasAttribute('data-steered'))).toEqual([true, false])
    })

    it('summarises an empty queue as nothing', () => {
      expect(queueSummary([])).toBeNull()
    })
  })

  describe('composer menus and quoted selections', () => {
    const options = (): string[] => [...container.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? '')
    const key = (k: string): void => {
      act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
    }
    const listCommands = (): void => {
      act(() => fake.emit({ type: 'thread_commands', session: 7, commands: ['compact'], skills: ['code-review'], terminal_only: ['model'] }))
    }

    it('asks for the commands on attach and inserts a sendable one without sending it', () => {
      mount()
      history([])
      expect(fake.sent).toContainEqual({ type: 'thread_commands_list', session: 7 })
      listCommands()
      type('/')
      expect(options()).toEqual([
        expect.stringContaining('/terminal'),
        expect.stringContaining('/code-review'),
        expect.stringContaining('/compact'),
        expect.stringMatching(/\/model.*Open in terminal/)
      ])
      expect(container.textContent).toContain('Terminal only')
      type('/com')
      expect(options()).toEqual([expect.stringContaining('/compact')])
      press({})
      expect(input().value).toBe('/compact ')
      expect(sends()).toEqual([])
      key('Escape')
      expect(options()).toEqual([])
    })

    it('says Claude has not listed commands yet, and a terminal-only command opens the terminal', () => {
      mount()
      history([])
      type('/')
      expect(container.textContent).toContain('Claude lists its commands and skills when this thread’s first message runs.')
      listCommands()
      type('/mod')
      press({})
      expect(fake.sent).toContainEqual({ type: 'session_set_view', session: 7, view: 'terminal' })
      expect(sends()).toEqual([])
      expect(input().value).toBe('/mod')
    })

    it('does not send a typed terminal-only command, and offers to open the terminal instead', () => {
      mount()
      history([])
      listCommands()
      type('/model claude-opus-5-5')
      press({})
      expect(sends()).toEqual([])
      expect(container.textContent).toContain('Not sent: /model runs only in a terminal pane')
      act(() => ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Open in terminal') as HTMLButtonElement).click())
      expect(fake.sent).toContainEqual({ type: 'session_set_view', session: 7, view: 'terminal' })
      expect(input().value).toBe('/model claude-opus-5-5')
    })

    it('puts the message back when the daemon refuses a command the composer did not know', () => {
      mount()
      history([])
      type('/login')
      press({})
      expect(sends()).toHaveLength(1)
      expect(input().value).toBe('')
      act(() => fake.emit({ type: 'error', message: 'thread_send refused for session 7: /login runs only in a terminal pane; open this conversation there with /terminal to run it', context: 'session:7' }))
      expect(input().value).toBe('/login')
      act(() => ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Open in terminal') as HTMLButtonElement).click())
      expect(fake.sent).toContainEqual({ type: 'session_set_view', session: 7, view: 'terminal' })
    })

    it('puts the message back when the daemon refuses it for any reason', () => {
      mount({ status: 'working' })
      history([])
      type('later')
      press({})
      expect(input().value).toBe('')
      act(() => fake.emit({ type: 'error', message: 'thread_send refused for session 7: the queue holds 16 messages, the limit (THREAD_QUEUE_MAX_ITEMS) is 16; send or remove one to queue a message', context: 'session:7' }))
      expect(input().value).toBe('later')
      expect(container.textContent).toContain('THREAD_QUEUE_MAX_ITEMS')
    })

    it('refuses a command that carries a quoted selection', () => {
      const off = registerTerminalSelection(9, () => 'x', { name: () => 'build', hidden: () => false })
      try {
        mount()
        history([])
        listCommands()
        click('thread-quote')
        type('/compact')
        key('Escape')
        press({})
        expect(sends()).toEqual([])
        expect(container.textContent).toContain('cannot carry quoted selections')
      } finally {
        off()
      }
    })

    it('keeps Open in terminal unavailable while the agent works, naming why', () => {
      mount({ status: 'working' })
      history([])
      listCommands()
      type('/terminal')
      press({})
      expect(fake.sent.some((msg) => msg.type === 'session_set_view')).toBe(false)
      expect(container.querySelector('[role="option"]')?.getAttribute('aria-disabled')).toBe('true')
    })

    it('lists files under the session directory for @ and inserts the relative path', async () => {
      search.mockResolvedValue({ items: [{ path: 'src/main.ts', name: 'main.ts', isDir: false, nameIndices: [], pathIndices: [] }], total: 1, truncated: false })
      mount({ cwd: '/work/repo' })
      history([])
      type('read @ma')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
      expect(search).toHaveBeenCalledWith('/work/repo', 'ma', 50)
      expect(options()).toEqual([expect.stringContaining('src/main.ts')])
      press({})
      expect(input().value).toBe('read @src/main.ts ')
      expect(sends()).toEqual([])
    })

    it('leaves symbolic links out of the @ menu', async () => {
      search.mockResolvedValue({
        items: [
          { path: 'link-to-home.txt', name: 'link-to-home.txt', isDir: false, symlink: true, nameIndices: [], pathIndices: [] },
          { path: 'notes.txt', name: 'notes.txt', isDir: false, symlink: false, nameIndices: [], pathIndices: [] }
        ],
        total: 2,
        truncated: false
      })
      mount({ cwd: '/work/repo' })
      history([])
      type('@txt')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
      expect(options()).toEqual([expect.stringContaining('notes.txt')])
    })

    it('shows a queued message’s selections while it is edited, and lets an excerpt carry it', () => {
      mount({ status: 'working' })
      history([ev(1, user('go'))])
      act(() => fake.emit({ type: 'thread_queue', session: 7, items: [{ id: 'q1', text: 'why?', state: 'queued', hold_reason: null, created_at_ms: 1, excerpts: [{ source: 'build', session: 9, text: 'a\nb' }] }] }))
      click('thread-queued-edit')
      expect(container.querySelector('[data-thread-item="queued"] [data-testid="thread-excerpt-chip"]')?.textContent).toBe('build · 2 lines')
      const field = container.querySelector('[data-testid="thread-queued-input"]') as HTMLTextAreaElement
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      act(() => { setter.call(field, ''); field.dispatchEvent(new Event('input', { bubbles: true })) })
      act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      expect(fake.sent.at(-1)).toEqual({ type: 'thread_queue_edit', session: 7, id: 'q1', text: '' })
    })

    it('quotes a terminal selection as a chip that shows its text, and sends it as an excerpt', () => {
      const selected = 'error[E0308]\nat main.rs:4'
      const off = registerTerminalSelection(9, () => selected, { name: () => 'build', hidden: () => false })
      const hidden = registerTerminalSelection(10, () => 'other grid', { name: () => 'elsewhere', hidden: () => true })
      try {
        mount()
        history([])
        click('thread-quote')
        const chip = container.querySelector('[data-testid="thread-excerpt-chip"] button') as HTMLButtonElement
        expect(chip.textContent).toBe('build · 2 lines')
        expect(container.querySelector('[data-testid="thread-excerpt-preview"]')).toBeNull()
        act(() => chip.click())
        expect(container.querySelector('[data-testid="thread-excerpt-preview"]')?.textContent).toBe(selected)
        type('Why?')
        press({})
        expect(sends()).toEqual([{ type: 'thread_send', session: 7, text: 'Why?', steer: false, excerpts: [{ source: 'build', session: 9, text: selected }] }])
        expect(container.querySelector('[data-testid="thread-excerpt-chip"]')).toBeNull()
      } finally {
        off()
        hidden()
      }
    })

    it('names an empty selection and lets a removed chip go', () => {
      mount()
      history([])
      click('thread-quote')
      expect(container.textContent).toContain('Nothing to quote: select text in a terminal pane of this grid first.')
      const off = registerTerminalSelection(9, () => 'x', { name: () => 'build', hidden: () => false })
      try {
        click('thread-quote')
        act(() => (container.querySelector('[aria-label="Remove build · 1 line"]') as HTMLButtonElement).click())
        expect(container.querySelector('[data-testid="thread-excerpt-chip"]')).toBeNull()
      } finally {
        off()
      }
    })

    it('draws a sent message’s selections as chips from its excerpts', () => {
      mount()
      history([ev(1, { type: 'user_message', delivery: 'direct', text: 'Why?', excerpts: [{ source: 'build', session: 9, text: 'a\nb' }] })])
      expect(rows('user')).toEqual(['build · 2 linesWhy?'])
    })
  })

  it('offers Open diff only for files under the pane folder', () => {
    mount({ cwd: '/repo' })
    const call = (id: string, name: string, input: object): ThreadEventKind => ({ type: 'tool_call', tool_use_id: id, name, input: JSON.stringify(input), truncated: false })
    const done = (id: string): ThreadEventKind => ({ type: 'tool_result', tool_use_id: id, is_error: false, output: 'ok', truncated: false })
    history([
      { seq: 1, at_ms: 0, kind: user('plan it') },
      { seq: 2, at_ms: 10, kind: call('w', 'Write', { file_path: '/home/dev/.claude/plans/p.md', content: 'plan\n' }) },
      { seq: 3, at_ms: 20, kind: done('w') },
      { seq: 4, at_ms: 30, kind: call('e', 'Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }) },
      { seq: 5, at_ms: 40, kind: done('e') },
      { seq: 6, at_ms: 50, kind: turnEnd() }
    ])
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-thread-item="changes"] li button')]
    expect(buttons.map((button) => [button.closest('li')!.textContent, button.disabled])).toEqual([
      [expect.stringContaining('/home/dev/.claude/plans/p.md'), true],
      [expect.stringContaining('src/a.ts'), false]
    ])
  })

  it('keeps the reading position when the row it ends at folds away', () => {
    mount()
    const read = (id: string): ThreadEventKind => ({ type: 'tool_call', tool_use_id: id, name: 'Read', input: JSON.stringify({ file_path: `/r/${id}` }), truncated: false })
    const done = (id: string): ThreadEventKind => ({ type: 'tool_result', tool_use_id: id, is_error: false, output: 'ok', truncated: false })
    const before = Array.from({ length: 600 }, (_, i) => ev(i + 1, user(`u${i + 1}`)))
    const work = Array.from({ length: 10 }, (_, i) => [ev(602 + 2 * i, read(`t${i}`)), ev(603 + 2 * i, done(`t${i}`))]).flat()
    const after = Array.from({ length: 143 }, (_, i) => ev(i + 700, user(`v${i}`)))
    history([...before, ev(601, user('work')), ...work, ev(650, said('m', 'Done.')), ev(651, turnEnd()), ...after])
    const toggle = (): void => act(() => container.querySelector<HTMLButtonElement>('[data-thread-item="turn"] button')!.click())
    toggle()
    // The first click grows the window; the second passes its cap and slides it to end at a Read row.
    for (let i = 0; i < 2; i++) click('thread-show-earlier')
    expect(rows('tool').length).toBeGreaterThan(0)
    expect(rows('user')).not.toContain('v142')
    toggle()
    expect(rows('user')).not.toContain('v142')
    const items = [...container.querySelectorAll('[data-thread-item]')]
    expect(items.at(-1)!.getAttribute('data-thread-item')).toBe('turn')
  })
})
