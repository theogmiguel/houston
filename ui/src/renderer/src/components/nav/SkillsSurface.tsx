import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SkillPushRecord } from '../../houston/generated/SkillPushRecord'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import type { HoustonClient } from '../../houston/client'
import { readFile } from '../../houston/bridge'
import { useHarness } from '../../houston/useHarness'
import { skillScopeLabel } from '../../houston/skillSurface'
import { IconRefresh } from '../icons'
import { lazy, Suspense, useEffect, useState } from 'react'
import { AgentSettingsBody } from '../ui/AgentSettingsBody'
import { CheckedStamp } from '../ui/CheckedStamp'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Row, SettingsList, SubHead } from '../ui/settingsPrimitives'
import { NavSurfaceContent, NavSurfaceFrame, NavSurfaceSection } from '../ui'
import { PanelFootnote, PanelIconButton } from '../ui/PanelInlineControls'
import { Switch } from '../ui/Switch'

const SkillsView = lazy(() =>
  import('../SkillsView').then((m) => ({ default: m.SkillsView }))
)

export function SkillsSurface(props: {
  embedded?: boolean
  client?: HoustonClient | null
  workspace?: string | null
  focusedPaneName?: string | null
  /** The focused pane's CLI; a ZCode pane spells a skill `/skill <name>`. */
  focusedPaneAgent?: AgentKind | null
  /** Why the focused pane cannot take a skill, or null when it can. */
  runBlockedReason?: string | null
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
    embedded = false,
    client = null,
    workspace = null,
    focusedPaneName = null,
    focusedPaneAgent = null,
    runBlockedReason = 'Focus a live agent pane to use this skill',
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

  const body = (
      <AgentSettingsBody embedded={embedded}>
        <Suspense fallback={<div />}>
          <SkillsView
            dir={workspace}
            embedded
            settingsPage={embedded}
            onChanged={onRefresh}
            tools={tools}
            pushes={pushes}
            onPush={onPush}
            onPushUndo={onPushUndo}
            onRun={runBlockedReason === null ? onRunSkill : undefined}
            runLabel={focusedPaneName ?? undefined}
            runDisabledReason={runBlockedReason}
            invocationAgent={focusedPaneAgent}
            scopeLabel={skillScopeLabel(workspace !== null)}
            usageDigest={usageDigest}
            hasHarnessReview={latestReview !== null}
            showAgentRelations
          />
        </Suspense>
        <NavSurfaceContent>
          <NavSurfaceSection>
            {!embedded && <SubHead>Distribution</SubHead>}
            <SettingsList>
              <Row
                variant="list"
                title={embedded ? "Keep copies in sync" : "Auto-push drift"}
                desc={embedded ? "When a skill changes, copy it into every agent that reads skills from its own folder." : "Copy a drifted or missing skill into every tool as soon as it changes."}
              >
                <div className="flex items-center gap-[var(--space-2)]">
                  <CheckedStamp at={checkedAt} />
                  <Tooltip label="Re-scan every tool's skills directory">
                    <PanelIconButton aria-label="Refresh distribution" onClick={onRefresh}>
                      <Icon glyph={IconRefresh} role="small" />
                    </PanelIconButton>
                  </Tooltip>
                  <Switch size="panel"
                    on={autoPushEnabled}
                    onChange={onAutoPushSet}
                    label="Auto-push drifted or missing copies to every tool"
                    testId="skills-auto-push"
                  />
                </div>
              </Row>
            </SettingsList>
          </NavSurfaceSection>
          {!embedded && <PanelFootnote>
            Open a skill to read its instructions, copy its invocation, or manage which agents can use it.
          </PanelFootnote>}
        </NavSurfaceContent>
      </AgentSettingsBody>
  )
  return embedded ? body : <NavSurfaceFrame>{body}</NavSurfaceFrame>
}
