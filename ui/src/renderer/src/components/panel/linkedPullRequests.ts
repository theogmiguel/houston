import type { PullRequestLink, PullRequestState, PrInfo, PrStackLayer, SessionInfo } from '../../houston/client'

export interface GridPrSource {
  dir: string
  pr: PrInfo
}

export interface GridPrStack {
  dir: string
  baseNumber: number
  layers: PrStackLayer[]
}

export function gridPrSources(
  sessions: ReadonlyMap<number, SessionInfo>,
  paneIds: readonly number[],
  prsByDir: ReadonlyMap<string, { pr: PrInfo | null }>,
): GridPrSource[] {
  const roots = new Set<string>()
  const sources: GridPrSource[] = []
  for (const id of paneIds) {
    const session = sessions.get(id)
    const root = session?.checkout?.root ?? session?.checkout_root
    if (!root || roots.has(root)) continue
    roots.add(root)
    const pr = prsByDir.get(root)?.pr
    if (pr) sources.push({ dir: root, pr })
  }
  return sources
}

function linkFromPrInfo(pr: PrInfo): PullRequestLink | null {
  if (pr.state !== 'open' && pr.state !== 'closed' && pr.state !== 'merged') return null
  const url = new URL(pr.url)
  const [owner, repositoryName] = url.pathname.split('/').filter(Boolean)
  if (!owner || !repositoryName) return null
  return {
    host: url.host,
    repository: `${owner}/${repositoryName}`,
    number: pr.number,
    url: pr.url,
    state: pr.state as PullRequestState,
    source: 'detected',
    title: pr.title,
    is_draft: pr.is_draft,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: 0,
    checks: pr.checks,
    review_decision: pr.review_decision,
    linked_at: 0,
  }
}

function linksFromStack(base: PullRequestLink, layers: readonly PrStackLayer[]): PullRequestLink[] {
  const url = new URL(base.url)
  const parts = url.pathname.split('/')
  const pullIndex = parts.lastIndexOf('pull')
  if (pullIndex < 0) return []
  return layers.map((layer) => {
    const layerUrl = new URL(base.url)
    const layerParts = layerUrl.pathname.split('/')
    layerParts[pullIndex + 1] = String(layer.number)
    layerUrl.pathname = layerParts.join('/')
    return {
      ...base,
      number: layer.number,
      url: layerUrl.toString(),
      state: layer.state,
      title: layer.title ?? null,
      is_draft: layer.is_draft,
    }
  })
}

export function buildLinkedPullRequests(
  sources: readonly GridPrSource[],
  stacks: readonly GridPrStack[] = [],
): PullRequestLink[] {
  const links = new Map<number, PullRequestLink>()
  const baseByDir = new Map<string, PullRequestLink>()
  for (const source of sources) {
    const link = linkFromPrInfo(source.pr)
    if (!link) continue
    if (!links.has(link.number)) links.set(link.number, link)
    baseByDir.set(source.dir, link)
  }
  for (const stack of stacks) {
    const base = baseByDir.get(stack.dir)
    if (!base || base.number !== stack.baseNumber) continue
    for (const link of linksFromStack(base, stack.layers)) {
      if (!links.has(link.number)) links.set(link.number, link)
    }
  }
  return [...links.values()]
}
