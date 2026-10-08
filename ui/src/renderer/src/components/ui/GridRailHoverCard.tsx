import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { formatCheckout } from '../checkout/formatCheckout'
import type { SessionCheckout } from '../../houston/generated/SessionCheckout'
import type { RailCard, CheckoutIdentity } from '../rail/railCardModel'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { Icon } from './Icon'
import { IconAgent, IconFolder, IconGitBranch, IconGitPullRequest, IconTag, IconTerminal, IconAlertTriangle } from '../icons'
import { PrLink } from './PrLink'
import './floatingSurface.css'

export const RAIL_HOVER_OPEN_DELAY_MS = 150
export const RAIL_HOVER_CLOSE_DELAY_MS = 0
export const RAIL_HOVER_WARM_WINDOW_MS = 400

export function useGridRailHoverWarmWindow(): { isWarm: () => boolean; markWarm: () => void } {
  const warmUntil = useRef(0)
  return {
    isWarm: () => Date.now() < warmUntil.current,
    markWarm: () => { warmUntil.current = Date.now() + RAIL_HOVER_WARM_WINDOW_MS }
  }
}

function checkoutFor(identity: CheckoutIdentity): { checkout: SessionCheckout | null; remoteHost?: string } {
  if (identity.kind === 'remote') return { checkout: null, remoteHost: identity.host }
  const kind = identity.kind === 'worktree'
    ? { worktree: { slug: identity.slug } }
    : identity.kind === 'primary' ? 'primary' : 'folder'
  return {
    checkout: { root: identity.root, kind, branch: 'branch' in identity ? identity.branch : null, head: null }
  }
}

export function GridRailHoverCard({
  card,
  tags = [],
  position,
  visible = true,
  onOpenInspector
}: {
  card: RailCard
  tags?: readonly TagInfo[]
  position: { left: number; top: number }
  visible?: boolean
  closeTimer: React.MutableRefObject<ReturnType<typeof window.setTimeout> | null>
  scheduleClose: () => void
  onOpenInspector?: (paneId: number, tab: 'changes' | 'pull-request') => void
}): React.JSX.Element {
  const pr = card.pr?.pr
  const firstPane = card.agents[0]?.session.id
  return createPortal(
    <div
      className={`grid-hover-card floating-glass ${visible ? 'floating-pop-in' : ''} fixed z-[var(--z-tooltip)] grid w-[300px] gap-[var(--space-2)]
        p-[var(--space-3)] text-[length:var(--tr-text-small-size)]
        transition-[opacity,transform,top] duration-150 ease-out`}
      style={{ ...position, transformOrigin: 'left top' }}
      role="tooltip"
      data-testid="grid-hover-card"
      data-visible={visible}
    >
      <strong className="min-w-0 truncate font-medium leading-[15px] text-[var(--text-primary)]">{card.title}</strong>
      <div className="grid gap-[var(--space-1-5)] pl-[var(--space-0-5)] text-[var(--text-secondary)]">
        <div className="flex items-center gap-2"><Icon glyph={IconFolder} role="small" className="text-[var(--text-muted)]" />{card.workspace.split('/').filter(Boolean).at(-1) ?? card.workspace}</div>
        <div className="flex items-center gap-2"><Icon glyph={IconTerminal} role="small" className="text-[var(--text-muted)]" />{card.checkouts[0]?.kind === 'remote' ? card.checkouts[0].host : 'Local'}</div>
        {card.checkouts.length > 0 && <div className="grid gap-[var(--space-1-5)]" data-testid="grid-hover-checkouts">
        {card.checkouts.slice(0, 1).map((identity) => {
          const formatted = checkoutFor(identity)
          const label = formatCheckout(formatted.checkout, { remoteHost: formatted.remoteHost })
          return <div
            key={`${identity.kind}:${'root' in identity ? identity.root : identity.host}`}
            className="flex min-w-0 items-center gap-[var(--space-2)]"
          >
            <Icon glyph={IconGitBranch} role="small" className="flex-none text-[var(--text-muted)]" />
            <span className="truncate font-mono [font-size:var(--tr-text-label-size)]">{card.agents.length && 'branch' in identity ? identity.branch ?? label.text : label.text}</span>
          </div>
        })}
        </div>}
        {card.agents[0] && <div className="flex items-center gap-2">
          <IconAgent agent={card.agents[0].agent} role="small" brand />
          <span>{card.agents[0].model ?? card.agents[0].agent}</span>
          {card.agents.length > 1 && <span className="text-[var(--text-muted)]">+{card.agents.length - 1} {card.agents.length === 2 ? 'agent' : 'agents'}</span>}
        </div>}
        {tags.length > 0 && <div className="flex flex-wrap items-center gap-2"><Icon glyph={IconTag} role="small" className="text-[var(--text-muted)]" />{tags.map((tag) => <span key={tag.id} className="inline-flex items-center gap-1"><i className="size-1.5 rounded-full" style={{ background: tag.color }} />{tag.name}</span>)}</div>}
        {card.status.kind === 'needs-input' && <div className="flex items-center gap-2 text-[var(--warn)]"><Icon glyph={IconAlertTriangle} role="small" />Waiting for your answer</div>}
      </div>
      {pr && (
        <PrLink
          href={pr.url}
          onClick={() => {
            if (firstPane != null) onOpenInspector?.(firstPane, 'pull-request')
          }}
          className="w-full min-w-0 justify-start gap-[var(--space-1-5)] border-t border-[var(--divider)]
            pt-[var(--space-2)] text-left text-[length:var(--tr-text-label-size)]"
          aria-label={`Open pull request ${pr.number}`}
        >
        <span className="inline-flex items-center gap-[var(--space-1)] font-mono text-[var(--text-muted)]">
          <Icon glyph={IconGitPullRequest} role="small" />#{pr.number}
        </span>
        <span className="min-w-0 truncate text-[var(--text-primary)]">{pr.title}</span>
        {card.agents.length === 0 && <><span className="flex-none text-[var(--text-muted)]">{pr.checks}</span><span className="flex-none font-mono text-[var(--ok)]">+{pr.additions}</span><span className="flex-none font-mono text-[var(--stop)]">−{pr.deletions}</span></>}
        </PrLink>
      )}
      {card.agents.length === 0 && <div className="text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">
        0 panes
      </div>}
    </div>,
    document.body
  )
}

export function GridRailHoverCardSpecimen(): React.JSX.Element {
  const closeTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const card: RailCard = {
    gridId: 'specimen',
    workspace: '/workspace',
    title: 'Surfaces redesign',
    pinned: false,
    status: { kind: 'working', label: 'Working', since: null },
    checkouts: [{
      kind: 'worktree',
      root: '/workspace/.worktrees/surfaces',
      slug: 'surfaces',
      branch: 'feat/surfaces',
      detached: false,
    }],
    pr: {
      gh: 'available',
      pr: {
        number: 42,
        url: 'https://github.com/example/houston/pull/42',
        state: 'OPEN',
        checks: 'passing',
        review_decision: null,
        title: 'Redesign surfaces',
        head_ref: 'feat/surfaces',
        additions: 214,
        deletions: 38,
        is_draft: false,
      },
    },
    diff: { added: 214, deleted: 38 },
    agents: [],
    lastActivityMs: 0
  }
  return <GridRailHoverCard card={card} position={{ left: 12, top: 12 }} closeTimer={closeTimer} scheduleClose={() => {}} />
}
