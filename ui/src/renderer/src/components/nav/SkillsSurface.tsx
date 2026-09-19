import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SkillPushRecord } from '../../houston/generated/SkillPushRecord'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import { IconRefresh } from '../icons'
import { lazy, Suspense } from 'react'
import { CHROME_BUTTON, NavColumn, NavFootnote, NavSwitch } from './navChrome'
import { CheckedStamp } from '../CheckedStamp'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'
import { Row, SettingsList, SubHead } from '../settingsPrimitives'
import { MATERIAL_CLS, materialAttrs } from '../material'

const SkillsView = lazy(() =>
  import('../SkillsView').then((m) => ({ default: m.SkillsView }))
)

export function SkillsSurface(props: {
  tools: SkillToolState[] | null
  pushes: SkillPushRecord[]
  autoPushEnabled: boolean
  onRefresh: () => void
  onPush: (tool?: AgentKind, skill?: string) => void
  onPushUndo: (tool: AgentKind, skill: string) => void
  onAutoPushSet: (enabled: boolean) => void
  checkedAt?: number | null
}): React.JSX.Element {
  const {
    tools,
    pushes,
    autoPushEnabled,
    onRefresh,
    onPush,
    onPushUndo,
    onAutoPushSet,
    checkedAt = null
  } = props
  return (
    <div
      data-testid="nav-surface"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full min-h-0 overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <NavColumn wide>
        <Suspense fallback={<div />}>
          <SkillsView dir={null} embedded onChanged={onRefresh} tools={tools} pushes={pushes} onPush={onPush} onPushUndo={onPushUndo} />
        </Suspense>
        {}
        <section className="mt-[var(--space-5)]">
          <SubHead>Distribution</SubHead>
          <SettingsList>
            <Row
              variant="list"
              title="Auto-push drift"
              desc="Copy a drifted or missing skill into every tool as soon as it changes."
            >
              <div className="flex items-center gap-[var(--space-2)]">
                <CheckedStamp at={checkedAt} />
                <Tooltip label="Re-scan every tool's skills directory">
                  <button
                    type="button"
                    aria-label="Refresh distribution"
                    className={CHROME_BUTTON}
                    onClick={onRefresh}
                  >
                    <Icon glyph={IconRefresh} role="small" />
                  </button>
                </Tooltip>
                <NavSwitch
                  on={autoPushEnabled}
                  onChange={onAutoPushSet}
                  label="Auto-push drifted or missing copies to every tool"
                  testId="skills-auto-push"
                />
              </div>
            </Row>
          </SettingsList>
        </section>
        <NavFootnote>
          Open a skill to read its instructions, copy its invocation, or manage which agents can use it.
        </NavFootnote>
      </NavColumn>
    </div>
  )
}
