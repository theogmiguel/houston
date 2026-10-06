import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SkillPushRecord } from '../../houston/generated/SkillPushRecord'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import type { HoustonClient } from '../../houston/client'
import { readFile } from '../../houston/bridge'
import { useHarness } from '../../houston/useHarness'
import { skillScopeLabel } from '../../houston/skillSurface'
import { IconRefresh } from '../icons'
import { lazy, Suspense, useEffect, useState } from 'react'
import { CHROME_BUTTON, NavFootnote, NavSwitch } from './navChrome'
import { PageFrame } from '../ui/PageFrame'
import { CheckedStamp } from '../ui/CheckedStamp'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Row, SettingsList, SubHead } from '../ui/settingsPrimitives'
import { MATERIAL_CLS, materialAttrs } from '../ui/material'

const SkillsView = lazy(() =>
  import('../SkillsView').then((m) => ({ default: m.SkillsView }))
)

export function SkillsSurface(props: {
  client?: HoustonClient | null
  workspace?: string | null
  focusedPaneName?: string | null
  canRunSkillInFocusedPane?: boolean
  onRunSkill?: (invoke: string) => void
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
    client = null,
    workspace = null,
    focusedPaneName = null,
    canRunSkillInFocusedPane = false,
    onRunSkill,
    tools,
    pushes,
    autoPushEnabled,
    onRefresh,
    onPush,
    onPushUndo,
    onAutoPushSet,
    checkedAt = null
  } = props
  const { state: harnessState } = useHarness(client, workspace)
  const latestReview = harnessState?.reviews.find((review) => review.status === 'published') ?? null
  const [usageDigest, setUsageDigest] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setUsageDigest(null)
    if (!latestReview) return () => { cancelled = true }
    readFile(`${latestReview.run_dir}/digest.jsonl`).then(
      (digest) => { if (!cancelled) setUsageDigest(digest) },
      () => { if (!cancelled) setUsageDigest(null) }
    )
    return () => { cancelled = true }
  }, [latestReview?.id, latestReview?.run_dir])

  const runDisabledReason = canRunSkillInFocusedPane
    ? null
    : 'Focus a live agent pane to use this skill'
  return (
    <div
      data-testid="nav-surface"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full min-h-0 overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <PageFrame width="wide" className="flex-1 min-w-0">
        <Suspense fallback={<div />}>
          <SkillsView
            dir={workspace}
            embedded
            onChanged={onRefresh}
            tools={tools}
            pushes={pushes}
            onPush={onPush}
            onPushUndo={onPushUndo}
            onRun={canRunSkillInFocusedPane ? onRunSkill : undefined}
            runLabel={focusedPaneName ?? undefined}
            runDisabledReason={runDisabledReason}
            scopeLabel={skillScopeLabel(workspace !== null)}
            usageDigest={usageDigest}
            hasHarnessReview={latestReview !== null}
            showAgentRelations
          />
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
      </PageFrame>
    </div>
  )
}
