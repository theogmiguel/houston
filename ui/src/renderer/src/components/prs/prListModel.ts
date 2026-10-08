import type { PrListItem } from '../../houston/client'
import type { PrSort } from '../../houston/generated/PrSort'

export type PullRequestSort = PrSort | 'blocked' | 'oldest' | 'largest' | 'smallest'

export interface PullRequestGroups {
  authored: PrListItem[]
  reviewRequested: PrListItem[]
  others: PrListItem[]
}

export function sortPullRequests(items: PrListItem[], sort: PullRequestSort): PrListItem[] {
  return [...items].sort((a, b) => {
    if (sort === 'created') return b.created_at - a.created_at
    if (sort === 'oldest') return a.created_at - b.created_at
    if (sort === 'largest') return b.additions + b.deletions - (a.additions + a.deletions)
    if (sort === 'smallest') return a.additions + a.deletions - (b.additions + b.deletions)
    if (sort === 'blocked')
      return Number(b.review_requested) - Number(a.review_requested) || b.updated_at - a.updated_at
    if (sort === 'ready') {
      const rank = (item: PrListItem): number =>
        item.mergeable === 'mergeable' ? 0 : item.mergeable === 'conflicting' ? 2 : 1
      return rank(a) - rank(b) || b.updated_at - a.updated_at
    }
    return b.updated_at - a.updated_at
  })
}

export function groupPullRequests(items: PrListItem[], currentUser: string, sort: PullRequestSort): PullRequestGroups {
  const groups: PullRequestGroups = { authored: [], reviewRequested: [], others: [] }
  for (const item of sortPullRequests(items, sort)) {
    if (item.author?.toLocaleLowerCase() === currentUser.toLocaleLowerCase()) groups.authored.push(item)
    else if (item.review_requested) groups.reviewRequested.push(item)
    else groups.others.push(item)
  }
  return groups
}

export function filterPullRequests(items: PrListItem[], query: string): PrListItem[] {
  const value = query.trim().toLocaleLowerCase()
  if (!value) return items
  const exactNumber = /^#?(\d+)$/.exec(value)
  if (exactNumber) return items.filter((item) => item.number === Number(exactNumber[1]))
  const tokens = value.split(/\s+/)
  const score = (item: PrListItem): number => {
    const title = item.title.toLocaleLowerCase()
    const branch = item.head_ref.toLocaleLowerCase()
    const author = (item.author ?? '').toLocaleLowerCase()
    const labels = item.labels.map((label) => label.name.toLocaleLowerCase())
    return tokens.reduce((total, rawToken) => {
      if (rawToken.startsWith('label:'))
        return total + (labels.some((label) => label.includes(rawToken.slice(6))) ? 1 : 0)
      return (
        total +
        (title.includes(rawToken)
          ? 8
          : branch.includes(rawToken)
            ? 4
            : author.includes(rawToken)
              ? 2
              : labels.some((label) => label.includes(rawToken))
                ? 1
                : 0)
      )
    }, 0)
  }
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}
