import type { SessionInfo } from '../../houston/client'
import { computeRects, launchPreviewTree, tidy, type LayoutNode } from '../../layout/tree'
import type { SessionSlot } from '../sessionPresets'
import { IconAgent } from '../icons'
import { ICON_ROLE_CLS } from './Icon'

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity',
  opencode: 'OpenCode', grok: 'Grok', zcode: 'ZCode', shell: 'Terminal'
}

function slotGeometry(rect: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  const half = 'calc(var(--pane-gutter) / 2)'
  const edge = 'var(--pane-gutter)'
  const left = rect.x === 0 ? edge : half
  const top = rect.y === 0 ? edge : half
  const right = rect.x + rect.w >= 100 ? edge : half
  const bottom = rect.y + rect.h >= 100 ? edge : half
  return {
    left: `calc(${rect.x}% + ${left})`,
    top: `calc(${rect.y}% + ${top})`,
    width: `calc(${rect.w}% - ${left} - ${right})`,
    height: `calc(${rect.h}% - ${top} - ${bottom})`
  }
}

function existingLabel(node: LayoutNode, sessions: Map<number, SessionInfo>): string {
  if (node.kind === 'leaf') return `Session · ${AGENT_NAMES[sessions.get(node.session)?.agent ?? ''] ?? 'Agent'}`
  if (node.kind === 'browser') return 'Browser'
  if (node.kind === 'editor') return 'Editor'
  if (node.kind === 'files') return 'Files'
  if (node.kind === 'skills') return 'Skills'
  if (node.kind === 'git') return 'Source control'
  return 'Pane'
}

export interface LaunchGridPreviewProps {
  tree: LayoutNode | null
  slots: SessionSlot[]
  target: 'this-grid' | 'new-grid'
  sessions: Map<number, SessionInfo>
}

export function LaunchGridPreview({ tree, slots, target, sessions }: LaunchGridPreviewProps): React.JSX.Element | null {
  const projected = tidy(launchPreviewTree(tree, slots.length, target))
  if (!projected) return null
  const leaves = computeRects(projected).leaves
  return (
    <div role="group" aria-label="Layout preview" data-testid="launch-grid-preview" className="pointer-events-none absolute inset-0 z-[var(--z-pane)] overflow-hidden bg-[var(--gutter-bg)]">
      {leaves.map(({ node, rect }, index) => {
        const newSlot = node.kind === 'leaf' && node.session < 0 ? slots[-node.session - 1] : undefined
        return (
          <div
            key={`${node.kind}-${node.kind === 'leaf' ? node.session : node.id}-${index}`}
            data-layout-slot={node.kind === 'leaf' ? node.session : node.id}
            data-new={newSlot ? 'true' : undefined}
            style={slotGeometry(rect)}
            data-preview-rect={`${rect.x},${rect.y},${rect.w},${rect.h}`}
            className={`absolute flex flex-col items-center justify-center overflow-hidden rounded-[var(--tr-radius-md)] ${newSlot ? 'border border-dashed border-[var(--border-hover)] bg-[color-mix(in_srgb,var(--accent)_7%,var(--card-bg))] text-[var(--text-secondary)]' : 'border border-[var(--border)] bg-[var(--tool-code-bg)] text-[var(--text-secondary)]'}`}
          >
            {newSlot ? (
              <div className="flex min-w-0 flex-col items-center gap-[var(--space-1)] px-[var(--space-3)] text-center [font-size:var(--tr-text-small-size)]">
                <span className="flex items-center gap-[var(--space-1-5)] text-[var(--text-primary)]">
                  <IconAgent agent={newSlot.agent} brand className={ICON_ROLE_CLS.ui} />
                  <span>{newSlot.roleLabel ?? AGENT_NAMES[newSlot.agent] ?? newSlot.agent}</span>
                </span>
                <span className="max-w-full truncate text-[var(--text-muted)]">
                  {[newSlot.model ?? 'agent default', newSlot.effort ?? 'default effort', 'this checkout'].join(' · ')}
                </span>
              </div>
            ) : <span className="[font-size:var(--tr-text-ui-size)]">{existingLabel(node, sessions)}</span>}
          </div>
        )
      })}
    </div>
  )
}

export function LaunchGridPreviewSpecimen(): React.JSX.Element {
  const slots: SessionSlot[] = [{ index: 0, agent: 'claude', roleLabel: 'builder', prompt: '', model: null, effort: null, modelSource: 'agent default', effortSource: 'agent default', agentSource: 'preset', headerSource: 'preset', skippedRoute: null, invalidReason: null }]
  return <div className="relative h-[240px] w-[480px] bg-[var(--gutter-bg)]"><LaunchGridPreview tree={null} slots={slots} target="new-grid" sessions={new Map()} /></div>
}
