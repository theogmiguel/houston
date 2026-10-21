// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PrDetail, PrThread } from '../../houston/client'
import { PrComments, PrInspectorComments, PrThreads } from './PrDiscussion'
import { resetPrDiscussionFilterForTests } from './prDiscussionFilter'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => {}

function remark(id: string, author: string, bot: boolean): PrThread['comments'][number] {
  return { id, author, body: `${author} says ${id}`, created_at: 1, url: null, reactions: [], bot }
}

const detail = {
  comments: [
    { id: 'IC_1', author: 'theo', body: 'ready for review', created_at: 1, url: null, reactions: [], bot: false },
    { id: 'IC_2', author: 'ci-app', body: 'coverage 91%', created_at: 2, url: null, reactions: [], bot: true }
  ],
  comments_total: 2,
  threads: [
    { id: 'T_open', path: 'src/a.rs', line: 1, resolved: false, outdated: false, comments: [remark('C1', 'rev', false)] },
    { id: 'T_bot', path: 'src/b.rs', line: 2, resolved: false, outdated: false, comments: [remark('C2', 'review-app', true)] },
    { id: 'T_done', path: 'src/c.rs', line: 3, resolved: true, outdated: false, comments: [remark('C3', 'rev', false)] }
  ],
  threads_truncated: false,
  threads_message: null,
  viewer: { can_write: true, can_triage: true, can_update: true, did_author: false, can_update_branch: true }
} as unknown as PrDetail

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(node: React.ReactNode): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
}

function q(selector: string): HTMLElement | null {
  return host!.querySelector<HTMLElement>(selector)
}

function click(element: Element | null): void {
  expect(element).not.toBeNull()
  act(() => (element as HTMLElement).click())
}

function threadIds(): string[] {
  return Array.from(host!.querySelectorAll('[data-testid^="pr-thread-state-"]')).map((el) => el.getAttribute('data-testid')!.slice('pr-thread-state-'.length))
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  localStorage.clear()
  resetPrDiscussionFilterForTests()
})

describe('PR discussion filters', () => {
  it('shows every thread by default and names how many each toggle would hide', () => {
    render(<PrThreads detail={detail} busy={false} number={7} onReply={noop} onResolve={noop} onReact={noop} />)
    expect(threadIds()).toEqual(['T_open', 'T_bot', 'T_done'])
    expect(q('[data-testid="pr-filter-hideResolved"]')!.getAttribute('aria-checked')).toBe('false')
    expect(q('[data-testid="pr-threads"]')!.textContent).toContain('Hide resolved (1)')
    expect(q('[data-testid="pr-threads"]')!.textContent).toContain('Hide bots (1)')
  })

  it('collapses resolved threads to one line that reveals them again', () => {
    render(<PrThreads detail={detail} busy={false} number={7} onReply={noop} onResolve={noop} onReact={noop} />)
    click(q('[data-testid="pr-filter-hideResolved"]'))
    expect(threadIds()).toEqual(['T_open', 'T_bot'])
    expect(q('[data-testid="pr-threads-resolved-hidden"]')!.textContent).toContain('1 resolved thread hidden')
    click(q('[data-testid="pr-threads-resolved-hidden"] button'))
    expect(threadIds()).toEqual(['T_open', 'T_bot', 'T_done'])
    expect(q('[data-testid="pr-filter-hideResolved"]')!.getAttribute('aria-checked')).toBe('false')
  })

  it('hides bot comments on every surface at once and remembers the choice', () => {
    render(<>
      <PrThreads detail={detail} busy={false} number={7} onReply={noop} onResolve={noop} onReact={noop} />
      <PrComments detail={detail} busy={false} onComment={noop} onCommentEdit={noop} onReact={noop} />
      <PrInspectorComments detail={detail} approvalsRequired={1} approvalsReceived={0} number={7} busy={false} onReply={noop} onResolve={noop} issueComments={null} />
    </>)
    click(q('[data-testid="pr-threads"] [data-testid="pr-filter-hideBots"]'))
    expect(threadIds()).toEqual(['T_open', 'T_done'])
    expect(q('[data-testid="pr-threads-bots-hidden"]')!.textContent).toContain('1 bot thread hidden')
    expect(q('[data-testid="pr-comments-bots-hidden"]')!.textContent).toContain('1 bot comment hidden')
    const inspector = Array.from(host!.querySelectorAll('[data-testid="pr-inspector-comment"]')).map((el) => el.textContent ?? '')
    expect(inspector.some((text) => text.includes('ci-app') || text.includes('review-app'))).toBe(false)
    expect(q('[data-testid="pr-inspector-bots-hidden"]')!.textContent).toContain('2 bot comments hidden')
    expect(JSON.parse(localStorage.getItem('houston.pr-discussion-filter')!)).toEqual({ hideResolved: false, hideBots: true })
  })

  it('shows a saved toggle even when this pull request has nothing for it to hide', () => {
    localStorage.setItem('houston.pr-discussion-filter', JSON.stringify({ hideResolved: true, hideBots: false }))
    const people = { ...detail, threads: [detail.threads[0]], comments: [detail.comments[0]] } as PrDetail
    render(<PrThreads detail={people} busy={false} number={7} onReply={noop} onResolve={noop} onReact={noop} />)
    expect(q('[data-testid="pr-filter-hideResolved"]')!.getAttribute('aria-checked')).toBe('true')
    expect(q('[data-testid="pr-filter-hideBots"]')).toBeNull()
    expect(q('[data-testid="pr-threads-resolved-hidden"]')).toBeNull()
  })
})
