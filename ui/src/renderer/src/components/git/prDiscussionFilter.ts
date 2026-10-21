import { useSyncExternalStore } from 'react'
import type { PrComment, PrThread } from '../../houston/client'

export interface PrDiscussionFilter {
  hideResolved: boolean
  hideBots: boolean
}

const KEY = 'houston.pr-discussion-filter'
const SHOW_ALL: PrDiscussionFilter = { hideResolved: false, hideBots: false }

function load(): PrDiscussionFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PrDiscussionFilter> | null
    return { hideResolved: saved?.hideResolved === true, hideBots: saved?.hideBots === true }
  } catch {
    return SHOW_ALL
  }
}

let current: PrDiscussionFilter | null = null
const listeners = new Set<() => void>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function getPrDiscussionFilter(): PrDiscussionFilter {
  current ??= load()
  return current
}

export function setPrDiscussionFilter(patch: Partial<PrDiscussionFilter>): void {
  current = { ...getPrDiscussionFilter(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
  }
  for (const listener of listeners) listener()
}

export function resetPrDiscussionFilterForTests(): void {
  current = null
}

export function usePrDiscussionFilter(): PrDiscussionFilter {
  return useSyncExternalStore(subscribe, getPrDiscussionFilter, () => SHOW_ALL)
}

// A thread counts as a bot's only while no person has joined it, so a human
// reply to a finding keeps the finding visible.
export function isBotThread(thread: PrThread): boolean {
  return thread.comments.length > 0 && thread.comments.every((comment) => comment.bot)
}

export function filterThreads(threads: PrThread[], filter: PrDiscussionFilter): {
  shown: PrThread[]
  resolved: number
  bots: number
  hiddenResolved: number
  hiddenBots: number
} {
  const resolved = threads.filter((thread) => thread.resolved).length
  const bots = threads.filter(isBotThread).length
  const afterResolved = filter.hideResolved ? threads.filter((thread) => !thread.resolved) : threads
  const shown = filter.hideBots ? afterResolved.filter((thread) => !isBotThread(thread)) : afterResolved
  return {
    shown,
    resolved,
    bots,
    hiddenResolved: threads.length - afterResolved.length,
    hiddenBots: afterResolved.length - shown.length
  }
}

export function filterComments(comments: PrComment[], filter: PrDiscussionFilter): {
  shown: PrComment[]
  bots: number
  hiddenBots: number
} {
  const bots = comments.filter((comment) => comment.bot).length
  const shown = filter.hideBots ? comments.filter((comment) => !comment.bot) : comments
  return { shown, bots, hiddenBots: comments.length - shown.length }
}

export function hiddenLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'} hidden`
}
