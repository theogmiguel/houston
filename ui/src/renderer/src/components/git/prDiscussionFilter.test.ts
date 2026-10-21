// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrComment, PrThread } from '../../houston/client'
import { filterComments, filterThreads, getPrDiscussionFilter, hiddenLabel, isBotThread, resetPrDiscussionFilterForTests, setPrDiscussionFilter } from './prDiscussionFilter'

const KEY = 'houston.pr-discussion-filter'

function remark(author: string, bot: boolean): PrThread['comments'][number] {
  return { id: `${author}-1`, author, body: 'note', created_at: 1, url: null, reactions: [], bot }
}

function thread(id: string, resolved: boolean, comments: PrThread['comments']): PrThread {
  return { id, path: 'src/a.rs', line: 1, resolved, outdated: false, comments }
}

function comment(id: string, bot: boolean): PrComment {
  return { id, author: bot ? 'ci-app' : 'theo', body: 'note', created_at: 1, url: null, reactions: [], bot }
}

afterEach(() => {
  localStorage.clear()
  resetPrDiscussionFilterForTests()
  vi.restoreAllMocks()
})

describe('PR discussion filtering', () => {
  const threads = [
    thread('human', false, [remark('rev', false)]),
    thread('bot', false, [remark('review-app', true)]),
    thread('answered-bot', false, [remark('review-app', true), remark('rev', false)]),
    thread('resolved-bot', true, [remark('review-app', true)]),
    thread('resolved', true, [remark('rev', false)])
  ]

  it('shows everything and counts what could be hidden when both toggles are off', () => {
    const view = filterThreads(threads, { hideResolved: false, hideBots: false })
    expect(view.shown.map((t) => t.id)).toEqual(['human', 'bot', 'answered-bot', 'resolved-bot', 'resolved'])
    expect([view.resolved, view.bots, view.hiddenResolved, view.hiddenBots]).toEqual([2, 2, 0, 0])
  })

  it('hides resolved threads, then bot-only threads, counting each once', () => {
    const view = filterThreads(threads, { hideResolved: true, hideBots: true })
    expect(view.shown.map((t) => t.id)).toEqual(['human', 'answered-bot'])
    expect(view.hiddenResolved).toBe(2)
    expect(view.hiddenBots).toBe(1)
  })

  it('keeps a bot finding a person has answered', () => {
    expect(isBotThread(threads[2])).toBe(false)
    expect(isBotThread(thread('empty', false, []))).toBe(false)
  })

  it('hides bot conversation comments only when asked', () => {
    const comments = [comment('a', false), comment('b', true)]
    expect(filterComments(comments, { hideResolved: true, hideBots: false }).shown).toHaveLength(2)
    const view = filterComments(comments, { hideResolved: false, hideBots: true })
    expect(view.shown.map((c) => c.id)).toEqual(['a'])
    expect([view.bots, view.hiddenBots]).toEqual([1, 1])
  })

  it('names the hidden count in the singular and plural', () => {
    expect(hiddenLabel(1, 'resolved thread')).toBe('1 resolved thread hidden')
    expect(hiddenLabel(3, 'bot comment')).toBe('3 bot comments hidden')
  })
})

describe('PR discussion filter preference', () => {
  it('defaults to showing everything', () => {
    expect(getPrDiscussionFilter()).toEqual({ hideResolved: false, hideBots: false })
  })

  it('persists each toggle and reads it back after a reload', () => {
    setPrDiscussionFilter({ hideBots: true })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hideResolved: false, hideBots: true })
    resetPrDiscussionFilterForTests()
    expect(getPrDiscussionFilter()).toEqual({ hideResolved: false, hideBots: true })
  })

  it('falls back to showing everything when the saved value is unreadable', () => {
    localStorage.setItem(KEY, '{not json')
    expect(getPrDiscussionFilter()).toEqual({ hideResolved: false, hideBots: false })
  })

  it('keeps the in-memory choice when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    setPrDiscussionFilter({ hideResolved: true })
    expect(getPrDiscussionFilter().hideResolved).toBe(true)
  })
})
