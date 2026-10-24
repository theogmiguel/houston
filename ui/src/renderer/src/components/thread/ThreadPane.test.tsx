// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HoustonClient, ServerMsg, SessionInfo } from '../../houston/client'
import { THREAD_HISTORY_PAGE } from '../../thread/threadStore'
import { THREAD_WINDOW_PAGE } from '../../thread/threadModel'
import type { ThreadEvent, ThreadEventKind } from '../../thread/threadTypes'
import { THREAD_STOPPED_COPY } from '../ui/Thread'
import { ThreadPane } from './ThreadPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface FakeClient {
  client: HoustonClient
  sent: { type: string; [key: string]: unknown }[]
  emit: (msg: object) => void
}

function fakeClient(): FakeClient {
  const listeners = new Set<(msg: ServerMsg) => void>()
  const sent: FakeClient['sent'] = []
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const listener = (msg: ServerMsg): void => { if (msg.type === kind) handler(msg) }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send: (msg: { type: string }) => sent.push(msg)
  } as unknown as HoustonClient
  return { client, sent, emit: (msg) => { for (const listener of [...listeners]) listener(msg as ServerMsg) } }
}

function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 7, agent: 'claude', state: 'running', status: 'idle', view: 'thread', ...over } as unknown as SessionInfo
}

function ev(seq: number, kind: ThreadEventKind): ThreadEvent {
  return { seq, at_ms: seq, kind }
}

const user = (text: string): ThreadEventKind => ({ type: 'user_message', text })

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

  const mount = (props: { status?: SessionInfo['status']; connected?: boolean } = {}): void => {
    act(() => {
      root.render(<ThreadPane client={fake.client} info={info({ status: props.status ?? 'idle' })} connected={props.connected ?? true} />)
    })
  }
  const history = (events: ThreadEvent[], hasMore = false): void => {
    act(() => fake.emit({ type: 'thread_history', session: 7, events, has_more: hasMore }))
  }
  const userRows = (): string[] => [...container.querySelectorAll('[data-thread-item="user"]')].map((row) => row.textContent ?? '')
  const input = (): HTMLTextAreaElement => container.querySelector('[data-testid="thread-composer-input"]')!
  const type = (text: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input(), text)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = (key: string, shiftKey = false): void => {
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })) })
  }

  it('asks for the latest history page on attach and appends only newer live events', () => {
    mount()
    expect(fake.sent).toEqual([{ type: 'thread_history', session: 7, before_seq: null, limit: THREAD_HISTORY_PAGE }])
    act(() => fake.emit({ type: 'thread_events', session: 7, events: [ev(2, user('early live'))] }))
    history([ev(1, user('first')), ev(2, user('early live'))])
    act(() => fake.emit({ type: 'thread_events', session: 7, events: [ev(2, user('early live')), ev(3, user('next'))] }))
    act(() => fake.emit({ type: 'thread_events', session: 8, events: [ev(4, user('other session'))] }))
    expect(userRows()).toEqual(['first', 'early live', 'next'])
  })

  it('sends on Enter, keeps Shift+Enter for a new line, and clears the field', () => {
    mount()
    history([])
    type('line one')
    press('Enter', true)
    expect(fake.sent.filter((msg) => msg.type === 'thread_send')).toEqual([])
    press('Enter')
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_send', session: 7, text: 'line one' })
    expect(input().value).toBe('')
  })

  it('offers Stop while the session is working and sends thread_stop', () => {
    mount({ status: 'working' })
    expect(container.querySelector('[data-testid="thread-send"]')).toBeNull()
    act(() => (container.querySelector('[data-testid="thread-stop"]') as HTMLButtonElement).click())
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_stop', session: 7 })
  })

  it('refuses a message above the daemon limit, naming the limit and the size', () => {
    mount()
    history([])
    type('x'.repeat(256 * 1024 + 1))
    press('Enter')
    expect(fake.sent.some((msg) => msg.type === 'thread_send')).toBe(false)
    expect(container.textContent).toContain('it is 256 KiB and a thread message is limited to 256 KiB')
  })

  it('disables the composer while disconnected', () => {
    mount({ connected: false })
    expect(fake.sent).toEqual([])
    expect(input().disabled).toBe(true)
    expect(input().placeholder).toBe('Reconnecting to the daemon')
  })

  it('answers a held permission request from its card and shows how it was resolved', () => {
    mount({ status: 'needs-input' })
    history([ev(1, { type: 'approval_request', request_id: 'r1', tool_use_id: 't1', tool_name: 'Bash', input: '{"command":"rm -rf build"}', truncated: false })])
    const card = (): HTMLElement => container.querySelector('[data-thread-item="approval"]')!
    expect(card().getAttribute('aria-label')).toBe('Permission request: Bash')
    expect(card().textContent).toContain('rm -rf build')
    const allow = container.querySelector<HTMLButtonElement>('[data-testid="thread-approval-allow"]')!
    const deny = container.querySelector<HTMLButtonElement>('[data-testid="thread-approval-deny"]')!
    expect(allow.tagName).toBe('BUTTON')
    act(() => deny.click())
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_approve', session: 7, request_id: 'r1', allow: false })
    act(() => allow.click())
    expect(fake.sent.at(-1)).toEqual({ type: 'thread_approve', session: 7, request_id: 'r1', allow: true })
    act(() => fake.emit({ type: 'thread_events', session: 7, events: [ev(2, { type: 'approval_resolved', request_id: 'r1', decision: 'denied', reason: 'Stopped in Houston before anyone answered.' })] }))
    expect(card().dataset.approvalState).toBe('denied')
    expect(card().textContent).toContain('Denied · Stopped in Houston before anyone answered.')
    expect(container.querySelector('[data-testid="thread-approval-allow"]')).toBeNull()
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

  it('marks a stopped turn as not remembered', () => {
    mount()
    history([ev(1, { type: 'assistant_delta', message_id: 'm', text: 'partial' }), ev(2, { type: 'turn_end', outcome: 'interrupted', error: null })])
    expect(container.textContent).toContain(THREAD_STOPPED_COPY)
  })

  it('renders a bounded window of a long history and pages earlier from the daemon', () => {
    mount()
    history(Array.from({ length: 1000 }, (_, i) => ev(i + 1, user(`m${i + 1}`))), true)
    expect(userRows()).toHaveLength(THREAD_WINDOW_PAGE)
    expect(userRows().at(-1)).toBe('m1000')
    const earlier = (): HTMLButtonElement => container.querySelector('[data-testid="thread-show-earlier"]')!
    for (let i = 0; i < 10; i++) act(() => earlier().click())
    expect(userRows().length).toBeLessThanOrEqual(400)
    expect(fake.sent.filter((msg) => msg.type === 'thread_history' && msg.before_seq === 1)).toHaveLength(1)
    expect(container.querySelector('[data-testid="thread-jump-latest"]')).not.toBeNull()
  })
})
