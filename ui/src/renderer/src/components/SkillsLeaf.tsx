import type { ComponentProps } from 'react'
import type { HoustonClient } from '../houston/client'
import type { PaneKey, SkillsNode } from '../layout/tree'
import { RING_ACCENT_ICON } from './shadowChrome'
import { lazy, Suspense, useEffect } from 'react'
import { IconClose, IconMaximize, IconMinimize, IconWrench } from './icons'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { Tooltip } from './Tooltip'
import { Icon } from './Icon'

const SkillsView = lazy(() =>
  import('./SkillsView').then((m) => ({ default: m.SkillsView }))
)

const ICO_HEAD_BASE =
  `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] [transition:background_0.16s_cubic-bezier(0.4,0,0.2,1),color_0.16s_ease,transform_0.18s_cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-px active:translate-y-0 active:scale-90 focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none`
const ICO_HEAD_DANGER =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)]'
const ICO_HEAD_REGULAR =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] hover:text-[var(--text-primary)]'
const ICO_HEAD_INFO =
  'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'
const PANE_TITLE_CLS =
  'pane-title font-medium tracking-[-0.01em] leading-[1.4] text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis min-w-[32px]'

export type SkillDistributionProps = Pick<ComponentProps<typeof SkillsView>, 'tools' | 'pushes' | 'onPush' | 'onPushUndo'>

interface Props extends SkillDistributionProps {
  client?: Pick<HoustonClient, 'skillSync'>
  node: SkillsNode
  dir: string
  onRun?: (invoke: string) => void
  onClose: () => void
  onHeaderPointerDown: (e: React.PointerEvent) => void
  expanded?: boolean
  onExpand?: (key: PaneKey) => void
}

export function SkillsLeaf({
  node,
  client,
  dir,
  onRun,
  onClose,
  onHeaderPointerDown,
  expanded = false,
  onExpand,
  tools,
  pushes,
  onPush,
  onPushUndo
}: Props): React.JSX.Element {
  useEffect(() => { client?.skillSync() }, [client])
  return (
    <section
      className="pane skills-leaf @container/rpanel flex-1 min-w-0 min-h-0 relative flex flex-col border border-[var(--border)] bg-[var(--pane-bg)] overflow-hidden rounded-[var(--tr-radius-md)] [@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)]"
      data-panekey={node.id}
    >
      <header
        className="group pane-head touch-none flex items-center gap-2 pr-1 pl-[10px] h-[var(--h-pane-head)] min-h-[var(--h-pane-head)] bg-[var(--session-terminal-header-bg)] border-b border-b-[color-mix(in_srgb,var(--border)_55%,transparent)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tracking-[-0.005em] text-[var(--text-primary)] flex-none cursor-grab active:cursor-grabbing [transition:background_0.2s,border-color_0.2s] @container"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          onHeaderPointerDown(e)
        }}
      >
        <span className="flex-none text-[var(--text-muted)]">
          <Icon glyph={IconWrench} role="ui" />
        </span>
        <span className={PANE_TITLE_CLS}>Skills</span>
        <span className="head-actions flex items-center gap-px flex-none ml-auto">
          {onExpand && (
            <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
              <button
                className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${expanded ? ICO_HEAD_INFO : ICO_HEAD_REGULAR}`}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                aria-pressed={expanded}
                onClick={(e) => {
                  e.stopPropagation()
                  onExpand(node.id)
                }}
              >
                {expanded ? <Icon glyph={IconMinimize} role="ui" /> : <Icon glyph={IconMaximize} role="ui" />}
              </button>
            </Tooltip>
          )}
          <Tooltip label="Close">
            <button
              className={`btn ${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_DANGER}`}
              aria-label="Close"
              onClick={onClose}
            >
              <Icon glyph={IconClose} role="ui" />
            </button>
          </Tooltip>
        </span>
      </header>
      <Suspense fallback={<div className="flex-1" />}>
        <SkillsView onChanged={() => client?.skillSync()} dir={dir} onRun={onRun} tools={tools} pushes={pushes} onPush={onPush} onPushUndo={onPushUndo} />
      </Suspense>
    </section>
  )
}
