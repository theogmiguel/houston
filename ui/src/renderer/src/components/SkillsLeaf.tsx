import type { ComponentProps } from 'react'
import type { HoustonClient } from '../houston/client'
import type { PaneKey, SkillsNode } from '../layout/tree'
import { lazy, Suspense, useEffect } from 'react'
import { IconClose, IconMaximize, IconMinimize, IconWrench } from './icons'
import { LeafPane, LeafPaneButton, LeafPaneHeader } from './ui/LeafPane'
import { Tooltip } from './ui/Tooltip'
import { Icon } from './ui/Icon'

const SkillsView = lazy(() =>
  import('./SkillsView').then((m) => ({ default: m.SkillsView }))
)

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
    <LeafPane marker="skills-leaf" data-panekey={node.id}>
      <LeafPaneHeader
        icon={<Icon glyph={IconWrench} role="ui" />}
        title="Skills"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          onHeaderPointerDown(e)
        }}
      >
        {onExpand && (
          <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
            <LeafPaneButton
              tone={expanded ? 'info' : 'regular'}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              aria-pressed={expanded}
              onClick={(e) => {
                e.stopPropagation()
                onExpand(node.id)
              }}
            >
              {expanded ? <Icon glyph={IconMinimize} role="ui" /> : <Icon glyph={IconMaximize} role="ui" />}
            </LeafPaneButton>
          </Tooltip>
        )}
        <Tooltip label="Close">
          <LeafPaneButton tone="danger" aria-label="Close" onClick={onClose}>
            <Icon glyph={IconClose} role="ui" />
          </LeafPaneButton>
        </Tooltip>
      </LeafPaneHeader>
      <Suspense fallback={<div className="flex-1" />}>
        <SkillsView onChanged={() => client?.skillSync()} dir={dir} onRun={onRun} tools={tools} pushes={pushes} onPush={onPush} onPushUndo={onPushUndo} />
      </Suspense>
    </LeafPane>
  )
}
