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
import { ThreadPane } from './ThreadPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

  it('accepts input in a thread without a process, and refuses it once the session is removed or asleep', () => {
    for (const state of ['exited', 'interrupted'] as const) {
      mount({ state })
      expect(input().disabled).toBe(false)
    }
    for (const state of ['killed', 'sleeping'] as const) {
      mount({ state })
      expect(input().disabled).toBe(true)
      expect(input().placeholder).toBe(`This session is ${state}`)
    }
  })

  it('disables the composer while disconnected', () => {
    mount({}, false)
    expect(fake.sent).toEqual([])
    expect(input().disabled).toBe(true)
    expect(input().placeholder).toBe('Reconnecting to the daemon')
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
