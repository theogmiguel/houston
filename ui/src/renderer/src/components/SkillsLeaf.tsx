import type { ComponentProps } from 'react'
import type { HoustonClient } from '../houston/client'
import type { PaneKey, SkillsNode } from '../layout/tree'
import { lazy, Suspense, useEffect } from 'react'
import { IconClose, IconMaximize, IconMinimize, IconWrench } from './icons'
import { PaneFrame } from './ui/PaneFrame'
import { PaneHeader } from './ui/PaneHeader'
import { PaneTitle } from './ui/PaneTitle'
import { Text } from './ui/Text'
import { PaneHeadActions, PaneHeadButton } from './ui/PaneControls'
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
    <PaneFrame kind="skills" focusTier="none" active={false} data-panekey={node.id}>
      <PaneHeader
        data-pane-focus-head="none"
        divider="borderMuted"
        transition="surface"
        inset="compact"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          onHeaderPointerDown(e)
        }}
      >
        <Text tone="muted" className="flex-none">
          <Icon glyph={IconWrench} role="ui" />
        </Text>
        <PaneTitle>Skills</PaneTitle>
        <PaneHeadActions>
          {onExpand && (
            <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
              <PaneHeadButton
                ladder={false}
                tone={expanded ? 'info' : 'regular'}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                aria-pressed={expanded}
                onClick={(e) => {
                  e.stopPropagation()
                  onExpand(node.id)
                }}
              >
                {expanded ? <Icon glyph={IconMinimize} role="ui" /> : <Icon glyph={IconMaximize} role="ui" />}
              </PaneHeadButton>
            </Tooltip>
          )}
          <Tooltip label="Close">
            <PaneHeadButton ladder={false} tone="danger" aria-label="Close" onClick={onClose}>
              <Icon glyph={IconClose} role="ui" />
            </PaneHeadButton>
          </Tooltip>
        </PaneHeadActions>
      </PaneHeader>
      <Suspense fallback={<div className="flex-1" />}>
        <SkillsView onChanged={() => client?.skillSync()} dir={dir} onRun={onRun} tools={tools} pushes={pushes} onPush={onPush} onPushUndo={onPushUndo} />
      </Suspense>
    </PaneFrame>
  )
}
