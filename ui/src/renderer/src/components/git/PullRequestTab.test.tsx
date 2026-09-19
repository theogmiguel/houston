// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  HoustonClient,
  PrComment,
  PrDetail,
  PrReaction,
  PrReviewDraft,
  PrThread,
  PullRequestLink
} from '../../houston/client'
import { BTN_PRIMARY } from '../buttonChrome'
import {
  checkMeta,
  parsePrNumber,
  PR_NUMBER_MAX,
  PullRequestTab,
  reviewLabel,
  stateLabel
} from './PullRequestTab'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeClient {
  prDetailCalls: Array<{ dir: string; request: number }> = []
  prDetailNumbers: Array<number | undefined> = []
  prLinkCalls: Array<{ dir: string; number: number; request: number }> = []
  prUnlinkCalls: Array<{ dir: string; request: number }> = []
  prMergeCalls: Array<{ dir: string; number: number; method: string; sha: string; request: number }> =
    []
  prCreateCalls: string[] = []
  prActionCalls: Array<{ number: number; action: string; mergeMethod?: string; updateMethod?: string; request: number }> = []
  prEditCalls: Array<{ number: number; title: string | null; body: string | null; request: number }> = []
  prCommentCalls: Array<{ number: number; body: string; request: number }> = []
  prCommentEditCalls: Array<{ number: number; commentId: string; kind: string; body: string; request: number }> = []
  prReviewCalls: Array<{ number: number; verdict: string; body: string; comments: PrReviewDraft[]; request: number }> = []
  prThreadReplyCalls: Array<{ number: number; threadId: string; body: string; request: number }> = []
  prThreadResolveCalls: Array<{ number: number; threadId: string; resolved: boolean; request: number }> = []
  prReactionCalls: Array<{ number: number; subjectId: string | null; content: PrReaction; reacted: boolean; request: number }> = []
  prReviewersCalls: Array<{ number: number; request: number }> = []
  prReviewerSetCalls: Array<{ number: number; reviewers: unknown[]; requested: boolean; request: number }> = []
  prLabelsCalls: Array<{ number: number; request: number }> = []
  prLabelSetCalls: Array<{ number: number; labels: string[]; applied: boolean; request: number }> = []
  prListCalls: Array<{ state: string; involvement: string; query: string | null; limit: number; request: number }> = []
  prDiffCalls: Array<{ number: number; request: number }> = []
  prStackCalls: Array<{ number: number; request: number }> = []
  prStackMergeCalls: Array<{ number: number; stackNumber: number; heads: unknown[]; method: string; request: number }> = []
  private seq = 0
  private subs = new Map<string, Set<(msg: never) => void>>()

  private next(): number {
    this.seq += 1
    return this.seq
  }
  prDetail(dir: string, number?: number): number {
    const request = this.next()
    this.prDetailCalls.push({ dir, request })
    this.prDetailNumbers.push(number)
    return request
  }
  prLink(dir: string, number: number): number {
    const request = this.next()
    this.prLinkCalls.push({ dir, number, request })
    return request
  }
  prUnlink(dir: string): number {
    const request = this.next()
    this.prUnlinkCalls.push({ dir, request })
    return request
  }
  prMerge(dir: string, number: number, method: string, sha: string): number {
    const request = this.next()
    this.prMergeCalls.push({ dir, number, method, sha, request })
    return request
  }
  prCreate(dir: string): void {
    this.prCreateCalls.push(dir)
  }
  prAction(
    _dir: string,
    number: number,
    action: string,
    opts: { mergeMethod?: string; updateMethod?: string } = {}
  ): number {
    const request = this.next()
    this.prActionCalls.push({ number, action, ...opts, request })
    return request
  }
  prEdit(_dir: string, number: number, title: string | null, body: string | null): number {
    const request = this.next()
    this.prEditCalls.push({ number, title, body, request })
    return request
  }
  prComment(_dir: string, number: number, body: string): number {
    const request = this.next()
    this.prCommentCalls.push({ number, body, request })
    return request
  }
  prCommentEdit(_dir: string, number: number, commentId: string, kind: string, body: string): number {
    const request = this.next()
    this.prCommentEditCalls.push({ number, commentId, kind, body, request })
    return request
  }
  prReview(_dir: string, number: number, verdict: string, body: string, comments: PrReviewDraft[]): number {
    const request = this.next()
    this.prReviewCalls.push({ number, verdict, body, comments, request })
    return request
  }
  prThreadReply(_dir: string, number: number, threadId: string, body: string): number {
    const request = this.next()
    this.prThreadReplyCalls.push({ number, threadId, body, request })
    return request
  }
  prThreadResolve(_dir: string, number: number, threadId: string, resolved: boolean): number {
    const request = this.next()
    this.prThreadResolveCalls.push({ number, threadId, resolved, request })
    return request
  }
  prReaction(_dir: string, number: number, subjectId: string | null, content: PrReaction, reacted: boolean): number {
    const request = this.next()
    this.prReactionCalls.push({ number, subjectId, content, reacted, request })
    return request
  }
  prReviewers(_dir: string, number: number): number {
    const request = this.next()
    this.prReviewersCalls.push({ number, request })
    return request
  }
  prReviewerSet(_dir: string, number: number, reviewers: unknown[], requested: boolean): number {
    const request = this.next()
    this.prReviewerSetCalls.push({ number, reviewers, requested, request })
    return request
  }
  prLabels(_dir: string, number: number): number {
    const request = this.next()
    this.prLabelsCalls.push({ number, request })
    return request
  }
  prLabelSet(_dir: string, number: number, labels: string[], applied: boolean): number {
    const request = this.next()
    this.prLabelSetCalls.push({ number, labels, applied, request })
    return request
  }
  prList(_dir: string, state: string, involvement: string, query: string | null, limit: number): number {
    const request = this.next()
    this.prListCalls.push({ state, involvement, query, limit, request })
    return request
  }
  prDiff(_dir: string, number: number): number {
    const request = this.next()
    this.prDiffCalls.push({ number, request })
    return request
  }
  prStack(_dir: string, number: number): number {
    const request = this.next()
    this.prStackCalls.push({ number, request })
    return request
  }
  prStackMerge(
    _dir: string,
    number: number,
    stackNumber: number,
    heads: unknown[],
    method: string
  ): number {
    const request = this.next()
    this.prStackMergeCalls.push({ number, stackNumber, heads, method, request })
    return request
  }
  subscribe(kind: string, handler: (msg: never) => void): () => void {
    let set = this.subs.get(kind)
    if (!set) {
      set = new Set()
      this.subs.set(kind, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }
  emit(msg: { type: string; [k: string]: unknown }): void {
    for (const h of Array.from(this.subs.get(msg.type) ?? [])) {
      ;(h as (msg: unknown) => void)(msg)
    }
  }
}

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567'

function link(o: Partial<PullRequestLink> = {}): PullRequestLink {
  return {
    host: 'GitHub',
    repository: 'o/r',
    number: 61,
    url: 'https://github.com/o/r/pull/61',
    state: 'open',
    source: 'detected',
    title: 'a change',
    is_draft: false,
    additions: 3,
    deletions: 1,
    changed_files: 2,
    checks: 'running',
    review_decision: null,
    linked_at: 1,
    merged_at: null,
    closed_at: null,
    synced_at: 1,
    ...o
  }
}

function detail(o: Partial<PrDetail> = {}): PrDetail {
  return {
    body: null,
    author: 'theo',
    base_ref: 'main',
    head_ref: 'feat/x',
    head_sha: HEAD_SHA,
    commit_count: 2,
    created_at: 1,
    updated_at: 2,
    mergeable: 'mergeable',
    merge_state: 'clean',
    checks: [
      { name: 'safety-checks', state: 'passing', url: null, duration_ms: 72_000 },
      { name: 'core-checks', state: 'running', url: null, duration_ms: null }
    ],
    comments: [],
    reviews: [],
    comments_total: 0,
    reviews_total: 0,
    merge_disabled_reason: 'PR #61 is waiting on 1 check: core-checks',
    viewer: {
      can_write: true,
      can_triage: true,
      can_update: true,
      did_author: false,
      can_update_branch: true
    },
    viewer_message: null,
    behind_by: null,
    labels: [],
    reviewers: [],
    reactions: [],
    threads: [],
    threads_truncated: false,
    threads_message: null,
    auto_merge_enabled: null,
    auto_merge_method: null,
    cross_repository: false,
    ...o
  }
}

function detailMsg(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'pr_detail',
    dir: '/repo',
    request: 1,
    gh: 'ready',
    has_upstream: true,
    link: link(),
    detail: detail(),
    linked: false,
    hint: null,
    message: null,
    ...o
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function teardown(): void {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
}

afterEach(teardown)

function render(client: FakeClient | null, opts: Record<string, unknown> = {}): void {
  act(() => {
    root!.render(
      <PullRequestTab
        client={client as unknown as HoustonClient | null}
        dir={(opts.dir as string | null | undefined) ?? '/repo'}
        active={(opts.active as boolean | undefined) ?? true}
        refreshSignal={(opts.refreshSignal as number | undefined) ?? 0}
        onOpenUrlInPane={opts.onOpenUrlInPane as ((url: string) => void) | undefined}
        onShowChanges={opts.onShowChanges as (() => void) | undefined}
        onPrPresenceChange={opts.onPrPresenceChange as ((exists: boolean) => void) | undefined}
      />
    )
  })
}

function mount(
  opts: {
    client?: FakeClient | null
    dir?: string | null
    active?: boolean
    refreshSignal?: number
    onOpenUrlInPane?: (url: string) => void
    onShowChanges?: () => void
    onPrPresenceChange?: (exists: boolean) => void
  } = {}
): FakeClient {
  container = document.createElement('div')
  document.body.appendChild(container)
  const client = opts.client === undefined ? new FakeClient() : opts.client
  root = createRoot(container)
  render(client, opts)
  return client as FakeClient
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel)
}
function qa<T extends Element = HTMLElement>(sel: string): T[] {
  return Array.from(document.querySelectorAll<T>(sel))
}
function click(el: Element | null): void {
  act(() => {
    ;(el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function openActions(): void {
  click(q('[data-testid="pr-actions-menu"]'))
}
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function typeIntoTextarea(input: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function emit(client: FakeClient, msg: Record<string, unknown>): void {
  act(() => client.emit(msg as never))
}
// A successful write: the daemon answers with the one mutation shape and then
// pushes the fresh detail, so tests settle writes the same way.
function settleWrite(client: FakeClient, request: number, kind = 'action'): void {
  emit(client, {
    type: 'pr_mutation',
    dir: '/repo',
    request,
    number: 61,
    kind,
    ok: true,
    message: null
  })
}

describe('PullRequestTab — reading a pull request', () => {
  it('asks for the detail on mount and renders checks, state and the merge gate', () => {
    const presence: boolean[] = []
    const client = mount({ onPrPresenceChange: (exists) => presence.push(exists) })
    expect(client.prDetailCalls).toEqual([{ dir: '/repo', request: 1 }])
    emit(client, detailMsg())
    expect(q('[data-testid="pr-title"]')!.textContent).toContain('a change')
    expect(q('[data-testid="pr-sub"]')!.textContent).toContain('#61 · feat/x → main · 2 commits')
    expect(qa('[data-testid="pr-check-row"]')).toHaveLength(2)
    expect(qa('[data-testid="pr-check-row"]').some((row) => row.textContent?.includes('1m 12s'))).toBe(true)
    expect(q('[data-testid="pr-merge"]')!.getAttribute('disabled')).not.toBeNull()
    expect(q('[data-testid="pr-merge-reason"]')!.textContent).toContain(
      'waiting on 1 check: core-checks'
    )
    expect(presence).toEqual([false, true])
  })

  it('opens on GitHub in a browser pane', () => {
    const onOpenUrl = vi.fn()
    const client = mount({ onOpenUrlInPane: onOpenUrl })
    emit(client, detailMsg())
    click(q('[data-testid="pr-open"]'))
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.com/o/r/pull/61')
  })

  it('merges with the sha on screen and the chosen method, and shows a refusal', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ merge_disabled_reason: null }) }))
    click(q('[data-testid="pr-merge"]'))
    expect(client.prMergeCalls).toEqual([
      { dir: '/repo', number: 61, method: 'squash', sha: HEAD_SHA, request: 2 }
    ])
    emit(client, {
      type: 'pr_merged',
      dir: '/repo',
      request: 2,
      number: 61,
      ok: false,
      message: 'PR #61 head moved from 0123456789abcdef0123456789abcdef01234567 to 89abcdef0123456789abcdef0123456789abcdef; refusing to merge an unseen commit'
    })
    expect(q('[data-testid="pr-merge-message"]')!.textContent).toContain('head moved')
  })

  it('a reply for another directory is dropped', () => {
    const client = mount()
    emit(client, detailMsg({ dir: '/elsewhere' }))
    expect(q('[data-testid="pr-loading"]')).not.toBeNull()
    expect(q('[data-testid="pr-title"]')).toBeNull()
  })

  it('re-reads when the panel refresh signal changes', () => {
    const client = new FakeClient()
    mount({ client, refreshSignal: 0 })
    expect(client.prDetailCalls).toHaveLength(1)
    emit(client, detailMsg({ request: 1 }))
    render(client, { refreshSignal: 1 })
    expect(client.prDetailCalls).toHaveLength(2)
  })
})

describe('PullRequestTab — housed footer primary', () => {
  it('renders one primary action only for states that have an affirmative action', () => {
    const cases: Array<{ name: string; link: PullRequestLink; primary: number }> = [
      { name: 'ready open', link: link(), primary: 1 },
      { name: 'draft open', link: link({ is_draft: true }), primary: 1 },
      { name: 'closed', link: link({ state: 'closed' }), primary: 0 },
      { name: 'merged', link: link({ state: 'merged' }), primary: 0 }
    ]

    for (const current of cases) {
      const client = mount()
      emit(
        client,
        detailMsg({
          link: current.link,
          detail: detail({ merge_disabled_reason: null })
        })
      )
      const primary = qa<HTMLButtonElement>('[data-testid="pr-actions"] button').filter((button) =>
        button.className.includes(BTN_PRIMARY) && button.dataset.testid !== 'pr-merge-options'
      )
      expect(primary, current.name).toHaveLength(current.primary)
      teardown()
    }
  })
})

describe('PullRequestTab — stale replies', () => {
  it('drops a stale same-directory read that lands after a newer link', () => {
    const client = mount()
    emit(client, detailMsg({ request: 1 }))
    openActions()
    click(q('[data-testid="pr-link-detected"]'))
    expect(client.prLinkCalls).toEqual([{ dir: '/repo', number: 61, request: 2 }])
    emit(client, { type: 'pr_linked', dir: '/repo', request: 2, ok: true, message: null })
    emit(client, detailMsg({ request: 2, linked: true, link: link({ source: 'manual' }) }))
    expect(q('[data-testid="pr-unlink"]')).not.toBeNull()
    emit(client, detailMsg({ request: 1, linked: false }))
    expect(q('[data-testid="pr-unlink"]')).not.toBeNull()
    expect(q('[data-testid="pr-link-detected"]')).toBeNull()
  })

  it('drops an old read that arrives while a link is still in flight', () => {
    const client = mount()
    emit(client, detailMsg({ request: 1, link: link({ title: 'before the link' }) }))
    expect(q('[data-testid="pr-title"]')!.textContent).toContain('before the link')
    openActions()
    click(q('[data-testid="pr-link-detected"]'))
    expect(client.prLinkCalls).toEqual([{ dir: '/repo', number: 61, request: 2 }])
    emit(client, detailMsg({ request: 1, link: link({ title: 'stale read' }) }))
    expect(q('[data-testid="pr-title"]')!.textContent).toContain('before the link')
    expect(q('[data-testid="pr-title"]')!.textContent).not.toContain('stale read')
  })

  it('a refresh after a failed mutation is not blocked by the superseded read', () => {
    const client = mount()
    emit(client, detailMsg({ request: 1 }))
    render(client, { refreshSignal: 1 })
    expect(client.prDetailCalls).toEqual([
      { dir: '/repo', request: 1 },
      { dir: '/repo', request: 2 }
    ])
    openActions()
    click(q('[data-testid="pr-link-detected"]'))
    expect(client.prLinkCalls).toEqual([{ dir: '/repo', number: 61, request: 3 }])
    emit(client, { type: 'pr_linked', dir: '/repo', request: 3, ok: false, message: 'boom' })
    expect(q('[data-testid="pr-link-message"]')!.textContent).toContain('boom')
    render(client, { refreshSignal: 2 })
    expect(client.prDetailCalls).toHaveLength(3)
  })

  it('ignores a refresh while a mutation is in flight so its own read lands', () => {
    const client = mount()
    emit(client, detailMsg({ request: 1, detail: detail({ merge_disabled_reason: null }) }))
    click(q('[data-testid="pr-merge"]'))
    expect(client.prMergeCalls).toEqual([
      { dir: '/repo', number: 61, method: 'squash', sha: HEAD_SHA, request: 2 }
    ])
    render(client, { refreshSignal: 1 })
    expect(client.prDetailCalls).toHaveLength(1)
    emit(client, {
      type: 'pr_merged',
      dir: '/repo',
      request: 2,
      number: 61,
      ok: true,
      message: null
    })
    emit(client, detailMsg({ request: 2, detail: detail({ merge_disabled_reason: null }) }))
    expect(q('[data-testid="pr-merge"]')).not.toBeNull()
  })

  it('drops a read issued before a panel remount, even on the same client', () => {
    const client = new FakeClient()
    mount({ client })
    emit(client, detailMsg({ request: 1 }))
    expect(q('[data-testid="pr-title"]')).not.toBeNull()
    teardown()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    render(client)
    expect(client.prDetailCalls).toHaveLength(2)
    emit(client, detailMsg({ request: 1, linked: false }))
    expect(q('[data-testid="pr-loading"]')).not.toBeNull()
    emit(client, detailMsg({ request: 2 }))
    expect(q('[data-testid="pr-title"]')).not.toBeNull()
  })

  it('resets the pending read when the client is replaced', () => {
    const first = new FakeClient()
    mount({ client: first })
    expect(first.prDetailCalls).toHaveLength(1)
    const second = new FakeClient()
    render(second)
    expect(second.prDetailCalls).toEqual([{ dir: '/repo', request: 1 }])
    emit(second, detailMsg({ request: 1 }))
    expect(q('[data-testid="pr-title"]')).not.toBeNull()
  })
})

describe('PullRequestTab — linking', () => {
  it('offers Link, never Unlink, for an auto-detected branch pull request', () => {
    const client = mount()
    emit(client, detailMsg({ linked: false }))
    expect(q('[data-testid="pr-unlink"]')).toBeNull()
    openActions()
    click(q('[data-testid="pr-link-detected"]'))
    expect(client.prLinkCalls).toEqual([{ dir: '/repo', number: 61, request: 2 }])
  })

  it('offers Unlink for a manual association', () => {
    const client = mount()
    emit(client, detailMsg({ linked: true, link: link({ source: 'manual' }) }))
    expect(q('[data-testid="pr-link-detected"]')).toBeNull()
    openActions()
    click(q('[data-testid="pr-unlink"]'))
    expect(client.prUnlinkCalls).toEqual([{ dir: '/repo', request: 2 }])
  })

  it('links a positive number and refuses 0 without sending', () => {
    const client = mount()
    emit(client, detailMsg({ link: null, detail: null }))
    const input = q<HTMLInputElement>('[data-testid="pr-link-number"]')!
    typeInto(input, '0')
    expect(q<HTMLButtonElement>('[data-testid="pr-link"]')!.disabled).toBe(true)
    typeInto(input, '61')
    click(q('[data-testid="pr-link"]'))
    expect(client.prLinkCalls).toEqual([{ dir: '/repo', number: 61, request: 2 }])
  })

  it('names the u32 range for a number the wire would reject', () => {
    const client = mount()
    emit(client, detailMsg({ link: null, detail: null }))
    const input = q<HTMLInputElement>('[data-testid="pr-link-number"]')!
    typeInto(input, String(PR_NUMBER_MAX + 1))
    expect(q<HTMLButtonElement>('[data-testid="pr-link"]')!.disabled).toBe(true)
    expect(q('[data-testid="pr-link-invalid"]')!.textContent).toContain('1-4294967295')
    expect(client.prLinkCalls).toHaveLength(0)
  })

  it('names a failed link with the server message', () => {
    const client = mount()
    emit(client, detailMsg({ link: null, detail: null }))
    const input = q<HTMLInputElement>('[data-testid="pr-link-number"]')!
    typeInto(input, '99')
    click(q('[data-testid="pr-link"]'))
    expect(client.prLinkCalls).toEqual([{ dir: '/repo', number: 99, request: 2 }])
    emit(client, {
      type: 'pr_linked',
      dir: '/repo',
      request: 2,
      ok: false,
      message: 'gh found no pull request #99 in /repo; check the number'
    })
    expect(q('[data-testid="pr-link-message"]')!.textContent).toContain('no pull request #99')
  })
})

describe('PullRequestTab — empty, blocked and failed states', () => {
  it('creates a pull request only when the branch has an upstream', () => {
    const client = mount()
    emit(client, detailMsg({ link: null, detail: null, has_upstream: true }))
    click(q('[data-testid="pr-create"]'))
    expect(client.prCreateCalls).toEqual(['/repo'])
  })

  it('disables creation when the branch has no upstream and still offers Changes', () => {
    const onShowChanges = vi.fn()
    const client = mount({ onShowChanges })
    emit(client, detailMsg({ link: null, detail: null, has_upstream: false }))
    expect(q<HTMLButtonElement>('[data-testid="pr-create"]')!.disabled).toBe(true)
    click(q('[data-testid="pr-show-changes"]'))
    expect(onShowChanges).toHaveBeenCalled()
  })

  it('reports a missing gh with its fix and a retry', () => {
    const client = mount()
    emit(
      client,
      detailMsg({
        gh: 'unauthenticated',
        link: null,
        detail: null,
        hint: 'gh is not signed in — run `gh auth login`'
      })
    )
    expect(q('[data-testid="pr-detail-blocked"]')!.textContent).toContain('gh auth login')
    click(q('[data-testid="pr-retry"]'))
    expect(client.prDetailCalls).toHaveLength(2)
  })

  it('shows a read failure instead of an empty state', () => {
    const client = mount()
    emit(
      client,
      detailMsg({
        link: null,
        detail: null,
        message: "could not read the branch's pull request in /repo: no such remote"
      })
    )
    expect(q('[data-testid="pr-detail-empty"]')!.textContent).toContain('no such remote')
    expect(q('[data-testid="pr-create"]')).toBeNull()
  })

  it('caps comments visibly when the list is bounded', () => {
    const client = mount()
    const comments = Array.from({ length: 20 }, (_, i) => ({
      id: `IC_${i}`,
      author: `user${i}`,
      body: `body ${i}`,
      created_at: i,
      url: null,
      reactions: []
    }))
    emit(
      client,
      detailMsg({
        detail: detail({ comments, comments_total: 43, merge_disabled_reason: null })
      })
    )
    expect(q('[data-testid="pr-comments-capped"]')!.textContent).toContain('Showing 20 of 43')
  })
})

describe('PullRequestTab helpers', () => {
  it('accepts only positive integers within u32 as a pull request number', () => {
    expect(parsePrNumber('61')).toBe(61)
    expect(parsePrNumber(' 61 ')).toBe(61)
    expect(parsePrNumber(String(PR_NUMBER_MAX))).toBe(PR_NUMBER_MAX)
    expect(parsePrNumber(String(PR_NUMBER_MAX + 1))).toBeNull()
    expect(parsePrNumber('0')).toBeNull()
    expect(parsePrNumber('-1')).toBeNull()
    expect(parsePrNumber('61a')).toBeNull()
    expect(parsePrNumber('')).toBeNull()
  })

  it('reports a real duration or the check state, never a fake one', () => {
    expect(checkMeta({ name: 'a', state: 'passing', url: null, duration_ms: 72_000 })).toBe(
      '1m 12s'
    )
    expect(checkMeta({ name: 'a', state: 'passing', url: null, duration_ms: 48_000 })).toBe('48s')
    expect(checkMeta({ name: 'a', state: 'running', url: null, duration_ms: null })).toBe('running')
    expect(checkMeta({ name: 'a', state: 'failing', url: null, duration_ms: null })).toBe('failed')
  })

  it('labels draft, review and state without inventing values', () => {
    expect(stateLabel(link({ is_draft: true }))).toBe('Draft')
    expect(stateLabel(link({ state: 'merged' }))).toBe('Merged')
    expect(reviewLabel(null)).toBe('No review yet')
    expect(reviewLabel('REVIEW_REQUIRED')).toBe('review requested')
    expect(reviewLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })
})

const PATCH = [
  'diff --git a/src/a.rs b/src/a.rs',
  '--- a/src/a.rs',
  '+++ b/src/a.rs',
  '@@ -1 +1,2 @@',
  '-old',
  '+new',
  '+extra'
].join('\n')

function thread(): PrThread {
  return {
    id: 'PRT_1',
    path: 'src/a.rs',
    line: 12,
    resolved: false,
    outdated: false,
    comments: [
      {
        id: 'PRRC_1',
        author: 'rev',
        body: 'rename this',
        created_at: 1,
        url: null,
        reactions: []
      }
    ]
  }
}

function comment(): PrComment {
  return { id: 'IC_1', author: 'theo', body: 'looks good', created_at: 1, url: null, reactions: [] }
}

describe('PullRequestTab — editing, comments and reviews', () => {
  it('edits the title and description through one write', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ body: 'old body' }) }))
    click(q('[data-testid="pr-edit-open"]'))
    const title = q<HTMLInputElement>('[data-testid="pr-edit-title"]')!
    expect(title.value).toBe('a change')
    typeInto(title, 'a better title')
    typeIntoTextarea(q<HTMLTextAreaElement>('[data-testid="pr-edit-body"]')!, 'a better body')
    click(q('[data-testid="pr-edit-save"]'))
    expect(client.prEditCalls).toEqual([
      { number: 61, title: 'a better title', body: 'a better body', request: 2 }
    ])
    emit(client, {
      type: 'pr_mutation',
      dir: '/repo',
      request: 2,
      number: 61,
      kind: 'edit',
      ok: true,
      message: null
    })
    expect(q('[data-testid="pr-write-message"]')).toBeNull()
  })

  it('writes a comment and an edit through the composer and the row', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ comments: [comment()], comments_total: 1 }) }))
    typeIntoTextarea(
      q<HTMLTextAreaElement>('[data-testid="pr-comment-composer"]')!,
      'a new remark'
    )
    click(q('[data-testid="pr-comment-send"]'))
    expect(client.prCommentCalls).toEqual([{ number: 61, body: 'a new remark', request: 2 }])
    settleWrite(client, 2, 'comment')

    click(q('[data-testid="pr-comment-edit-IC_1"]'))
    typeIntoTextarea(
      q<HTMLTextAreaElement>('[data-testid="pr-comment-editor-IC_1"]')!,
      'a fixed remark'
    )
    click(q('[data-testid="pr-comment-save-IC_1"]'))
    expect(client.prCommentEditCalls).toEqual([
      { number: 61, commentId: 'IC_1', kind: 'issue_comment', body: 'a fixed remark', request: 3 }
    ])
  })

  it('submits one review carrying the inline drafts built on the remote diff', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ merge_disabled_reason: null }) }))
    click(q('[data-testid="pr-pane-files"]'))
    expect(client.prDiffCalls).toEqual([{ number: 61, request: 2 }])
    emit(client, {
      type: 'pr_diff',
      dir: '/repo',
      request: 2,
      number: 61,
      patch: PATCH,
      truncated: false,
      message: null
    })
    expect(q('[data-testid="pr-file"]')).not.toBeNull()
    click(q('[data-testid="pr-line-comment-right-1"]'))
    typeIntoTextarea(
      q<HTMLTextAreaElement>('[data-testid="pr-line-composer-text"]')!,
      'name it better'
    )
    click(q('[data-testid="pr-line-composer-add"]'))
    expect(q('[data-testid="pr-review-drafts"]')).toBeNull()
    click(q('[data-testid="pr-review-drafts-toggle"]'))
    expect(q('[data-testid="pr-review-drafts"]')!.textContent).toContain('src/a.rs · new line 1')
    typeIntoTextarea(q<HTMLTextAreaElement>('[data-testid="pr-review-body"]')!, 'please fix')
    click(q('[data-testid="pr-review-submit"]'))
    expect(client.prReviewCalls).toEqual([
      {
        number: 61,
        verdict: 'comment',
        body: 'please fix',
        comments: [{ path: 'src/a.rs', side: 'right', line: 1, body: 'name it better' }],
        request: 3
      }
    ])
    expect(q('[data-testid="pr-review-drafts"]')).toBeNull()
  })

  it('replies to and resolves a discussion by its node id', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ threads: [thread()] }) }))
    expect(q('[data-testid="pr-threads"]')!.textContent).toContain('rename this')
    typeIntoTextarea(q<HTMLTextAreaElement>('[data-testid="pr-thread-reply-PRT_1"]')!, 'agreed')
    click(q('[data-testid="pr-thread-reply-send-PRT_1"]'))
    expect(client.prThreadReplyCalls).toEqual([
      { number: 61, threadId: 'PRT_1', body: 'agreed', request: 2 }
    ])
    settleWrite(client, 2, 'thread_reply')
    click(q('[data-testid="pr-thread-resolve-PRT_1"]'))
    expect(client.prThreadResolveCalls).toEqual([
      { number: 61, threadId: 'PRT_1', resolved: true, request: 3 }
    ])
  })

  it('reacts to the pull request through the picker', () => {
    const client = mount()
    emit(
      client,
      detailMsg({
        detail: detail({
          reactions: [{ content: 'thumbs_up', count: 2, reacted: false }]
        })
      })
    )
    click(q('[data-testid="pr-reaction-add"]'))
    click(q('[data-testid="pr-reaction-pick-heart"]'))
    expect(client.prReactionCalls).toEqual([
      { number: 61, subjectId: null, content: 'heart', reacted: false, request: 2 }
    ])
    settleWrite(client, 2, 'reaction')
    click(q('[data-testid="pr-reaction-thumbs_up"]'))
    expect(client.prReactionCalls[1]).toEqual({
      number: 61,
      subjectId: null,
      content: 'thumbs_up',
      reacted: true,
      request: 3
    })
  })
})

describe('PullRequestTab — reviewers, labels and actions', () => {
  it('requests reviewers from the candidate list GitHub returned', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ reviewers: [{ id: 'octo', kind: 'user' }] }) }))
    expect(q('[data-testid="pr-reviewers-value"]')!.textContent).toContain('octo')
    click(q('[data-testid="pr-reviewers-manage"]'))
    expect(client.prReviewersCalls).toEqual([{ number: 61, request: 2 }])
    emit(client, {
      type: 'pr_reviewer_candidates',
      dir: '/repo',
      request: 2,
      candidates: [
        { id: 'octo', kind: 'user', login: 'octo', name: null, is_requested: true },
        { id: 'mona', kind: 'user', login: 'mona', name: null, is_requested: false }
      ],
      truncated: false,
      message: null
    })
    click(q('[data-testid="pr-reviewer-user:mona"]'))
    click(q('[data-testid="pr-reviewer-user:octo"]'))
    click(q('[data-testid="pr-reviewers-apply"]'))
    expect(client.prReviewerSetCalls).toEqual([
      {
        number: 61,
        reviewers: [{ id: 'mona', kind: 'user' }],
        requested: true,
        request: 3
      }
    ])
    // The removal is the second request, issued once the first is answered.
    emit(client, {
      type: 'pr_mutation',
      dir: '/repo',
      request: 3,
      number: 61,
      kind: 'reviewer_set',
      ok: true,
      message: null
    })
    expect(client.prReviewerSetCalls[1]).toEqual({
      number: 61,
      reviewers: [{ id: 'octo', kind: 'user' }],
      requested: false,
      request: 4
    })
  })

  it('toggles a label straight from the candidate list', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ labels: [{ name: 'bug', color: null }] }) }))
    click(q('[data-testid="pr-labels-manage"]'))
    expect(client.prLabelsCalls).toEqual([{ number: 61, request: 2 }])
    emit(client, {
      type: 'pr_label_candidates',
      dir: '/repo',
      request: 2,
      candidates: [
        { name: 'bug', color: 'd73a4a', description: null, is_applied: true },
        { name: 'docs', color: null, description: null, is_applied: false }
      ],
      truncated: false,
      message: null
    })
    click(q('[data-testid="pr-label-candidate-docs"]'))
    expect(client.prLabelSetCalls).toEqual([
      { number: 61, labels: ['docs'], applied: true, request: 3 }
    ])
  })

  it('sends a state action and shows the server’s own words', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ merge_disabled_reason: null }) }))
    openActions()
    click(q('[data-testid="pr-action-close"]'))
    expect(client.prActionCalls).toEqual([{ number: 61, action: 'close', request: 2 }])
    emit(client, {
      type: 'pr_mutation',
      dir: '/repo',
      request: 2,
      number: 61,
      kind: 'action',
      ok: true,
      message: 'closed PR #61'
    })
    expect(q('[data-testid="pr-write-notice"]')!.textContent).toContain('closed PR #61')
  })

  it('disables every state action when the permission read failed', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ viewer: null, viewer_message: 'boom' }) }))
    openActions()
    click(q('[data-testid="pr-action-close"]'))
    expect(client.prActionCalls).toHaveLength(0)
    expect(q('[data-testid="pr-action-close"]')!.getAttribute('disabled')).not.toBeNull()
    expect(q('[data-testid="pr-viewer-message"]')!.textContent).toContain('boom')
  })

  it('enables auto-merge with the chosen method and disables it once armed', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ merge_disabled_reason: null }) }))
    openActions()
    click(q('[data-testid="pr-action-auto-merge"]'))
    expect(client.prActionCalls).toEqual([
      { number: 61, action: 'enable_auto_merge', mergeMethod: 'squash', request: 2 }
    ])
    settleWrite(client, 2, 'action')
    emit(
      client,
      detailMsg({
        request: 2,
        detail: detail({
          merge_disabled_reason: null,
          auto_merge_enabled: true,
          auto_merge_method: 'squash'
        })
      })
    )
    expect(q('[data-testid="pr-action-auto-merge"]')!.textContent).toContain('Disable')
    click(q('[data-testid="pr-action-auto-merge"]'))
    expect(client.prActionCalls[1]).toEqual({
      number: 61,
      action: 'disable_auto_merge',
      mergeMethod: 'squash',
      request: 3
    })
  })
})

describe('PullRequestTab — browsing', () => {
  it('lists, filters and opens a row as a browsed pull request', () => {
    const client = mount()
    emit(client, detailMsg())
    click(q('[data-testid="pr-browse-open"]'))
    expect(client.prListCalls).toEqual([
      { state: 'open', involvement: 'all', query: null, limit: 25, request: 2 }
    ])
    emit(client, {
      type: 'pr_list',
      dir: '/repo',
      request: 2,
      items: [
        {
          number: 62,
          title: 'newer work',
          url: 'https://github.com/o/r/pull/62',
          state: 'open',
          is_draft: false,
          author: 'theo',
          head_ref: 'feat/y',
          base_ref: 'main',
          updated_at: 2,
          additions: 1,
          deletions: 1,
          review_decision: null,
          checks: 'passing',
          labels: []
        }
      ],
      truncated: false,
      message: null
    })
    click(q('[data-testid="pr-browse-row-62"]'))
    expect(client.prDetailNumbers).toEqual([undefined, 62])
  })

  it('asks for a bigger page when Load more is pressed', () => {
    const client = mount()
    emit(client, detailMsg())
    click(q('[data-testid="pr-browse-open"]'))
    emit(client, {
      type: 'pr_list',
      dir: '/repo',
      request: 2,
      items: [],
      truncated: true,
      message: null
    })
    click(q('[data-testid="pr-browse-more"]'))
    expect(client.prListCalls[1].limit).toBe(50)
  })
})

describe('PullRequestTab — stacks', () => {
  const stackReply = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'pr_stack',
    dir: '/repo',
    request: 2,
    stack: {
      id: 'ST_1',
      number: 5,
      url: 'https://github.com/o/r/stacks/5',
      base: 'main',
      layers: [
        {
          number: 61,
          head_ref: 'feat/x',
          state: 'open',
          is_draft: false,
          title: 'a change',
          head_sha: HEAD_SHA
        }
      ]
    },
    message: null,
    ...o
  })

  it('loads the stack on demand and merges it with the layer heads it showed', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ merge_disabled_reason: null }) }))
    expect(q('[data-testid="pr-stack-value"]')!.textContent).toContain('not checked')
    click(q('[data-testid="pr-stack-load"]'))
    expect(client.prStackCalls).toEqual([{ number: 61, request: 2 }])
    emit(client, stackReply())
    expect(q('[data-testid="pr-stack-value"]')!.textContent).toContain('#5')
    expect(q('[data-testid="pr-stack-layer-61"]')!.textContent).toContain('a change')
    openActions()
    click(q('[data-testid="pr-stack-merge"]'))
    expect(client.prStackMergeCalls).toEqual([
      {
        number: 61,
        stackNumber: 5,
        heads: [{ number: 61, head_sha: HEAD_SHA }],
        method: 'squash',
        request: 3
      }
    ])
  })

  it('says so when the host serves no stack', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ merge_disabled_reason: null }) }))
    click(q('[data-testid="pr-stack-load"]'))
    emit(client, { type: 'pr_stack', dir: '/repo', request: 2, stack: null, message: null })
    expect(q('[data-testid="pr-stack-none"]')!.textContent).toContain('no stack')
    expect(q('[data-testid="pr-stack-merge"]')).toBeNull()
  })

  it('refuses to merge a stack whose layer is still a draft', () => {
    const client = mount()
    emit(client, detailMsg({ detail: detail({ merge_disabled_reason: null }) }))
    click(q('[data-testid="pr-stack-load"]'))
    emit(
      client,
      stackReply({
        stack: {
          id: 'ST_1',
          number: 5,
          url: 'u',
          base: 'main',
          layers: [
            {
              number: 61,
              head_ref: 'feat/x',
              state: 'open',
              is_draft: true,
              title: null,
              head_sha: HEAD_SHA
            }
          ]
        }
      })
    )
    openActions()
    click(q('[data-testid="pr-stack-merge"]'))
    expect(client.prStackMergeCalls).toHaveLength(0)
    expect(q('[data-testid="pr-stack-merge"]')!.getAttribute('disabled')).not.toBeNull()
  })
})
