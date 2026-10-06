import { useEffect, useRef, useState } from 'react'
import { EmptyState } from './ui/ActionEmptyState'
import { WorkspacesEmpty, type WorkspacesEmptyProps } from './WorkspacesEmpty'
import { Icon } from './ui/Icon'
import { IconGitFork } from './icons'
import type { OrchestrationCaps } from '../houston/generated/OrchestrationCaps'
import { MATERIAL_CLS, materialAttrs } from './ui/material'
import type { AgentHookState } from '../houston/generated/AgentHookState'
import type { AgentKind } from '../houston/generated/AgentKind'
import { FirstRunHooksStep } from './ui/FirstRunHooksStep'
import { firstRunHookInstallCount, firstRunHookRows } from './firstRunHooks'

export type FirstRunStepId = 'workspace' | 'orchestration' | 'hooks'

export interface FirstRunProps {
  workspaces: WorkspacesEmptyProps
  hasWorkspace: boolean
  orchestrationConsented: boolean
  stateKnown: boolean
  caps: OrchestrationCaps | null
  onEnableOrchestration: () => void
  hooksInstalled: boolean
  agentHooks: AgentHookState[] | null
  onAgentHooksSet: (provider: AgentKind, enabled: boolean) => void
  onDone: () => void
}

const FIRST_RUN_STEPS: FirstRunStepId[] = ['workspace', 'orchestration', 'hooks']

function unmetSteps(p: {
  hasWorkspace: boolean
  orchestrationConsented: boolean
  hooksInstalled: boolean
}): FirstRunStepId[] {
  const out: FirstRunStepId[] = []
  if (!p.hasWorkspace) out.push('workspace')
  if (!p.orchestrationConsented) out.push('orchestration')
  if (!p.hooksInstalled) out.push('hooks')
  return out
}

// No "onboarding done" flag, deliberately: each prerequisite is read from live
// state every render, and `planRef` is snapshotted once so the step counter cannot
// renumber under the user. The latch only ever advances, never rewinds.
export function FirstRun({
  workspaces,
  hasWorkspace,
  orchestrationConsented,
  stateKnown,
  caps,
  onEnableOrchestration,
  hooksInstalled,
  agentHooks,
  onAgentHooksSet,
  onDone
}: FirstRunProps): React.JSX.Element | null {
  const planRef = useRef<FirstRunStepId[] | null>(null)
  if (stateKnown && planRef.current === null) {
    planRef.current = unmetSteps({ hasWorkspace, orchestrationConsented, hooksInstalled })
  }
  const plan = planRef.current
  const [skipped, setSkipped] = useState<FirstRunStepId[]>([])

  const satisfied = useRef<Set<FirstRunStepId>>(new Set()).current
  const stillUnmet = unmetSteps({ hasWorkspace, orchestrationConsented, hooksInstalled })
  for (const s of FIRST_RUN_STEPS) {
    if (!stillUnmet.includes(s)) satisfied.add(s)
  }
  const current = plan?.find((s) => !satisfied.has(s) && !skipped.includes(s))

  useEffect(() => {
    if (plan && !current) onDone()
  }, [plan, current, onDone])

  if (!plan) return <WorkspacesEmpty {...workspaces} />
  if (!current) return null

  const stepNumber = FIRST_RUN_STEPS.indexOf(current) + 1
  const skip = (): void => setSkipped((prev) => [...prev, current])

  const footer = (
    <div
      data-testid="first-run-footer"
      className="mt-[var(--space-4)] flex flex-col items-center gap-[var(--space-2)]"
    >
      <span
        data-testid="first-run-step"
        className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]"
      >
        Step <span className="tabular-nums">{stepNumber}</span> of {FIRST_RUN_STEPS.length}
      </span>
      {current !== 'workspace' && (
        <button
          type="button"
          data-testid="first-run-skip"
          onClick={skip}
          className="border-0 bg-transparent cursor-pointer rounded-[var(--tr-radius-button)] px-[var(--space-2)] py-[2px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          Not now
        </button>
      )}
    </div>
  )

  if (current === 'workspace') return <WorkspacesEmpty {...workspaces} footer={footer} />

  if (current === 'hooks') {
    const rows = firstRunHookRows(agentHooks ?? [])
    const installCount = firstRunHookInstallCount(rows)
    const absentCount = rows.filter((row) => row.status === 'not-found').length
    const disabledReason = installCount > 0
      ? null
      : absentCount === rows.length
        ? 'No supported CLI was found on PATH.'
        : 'All present CLIs are already reporting.'

    return (
      <FirstRunHooksStep
        steps={FIRST_RUN_STEPS.map((step) => ({
          label: step === 'workspace' ? 'Workspace' : step === 'orchestration' ? 'Orchestration' : 'Hooks',
          state: satisfied.has(step) ? 'done' : skipped.includes(step) ? 'skipped' : step === current ? 'current' : 'upcoming'
        }))}
        rows={rows}
        installCount={installCount}
        disabledReason={disabledReason}
        onSet={onAgentHooksSet}
        onInstallAll={() => rows.filter((row) => row.status === 'silent').forEach((row) => onAgentHooksSet(row.provider, true))}
        onSkip={skip}
      />
    )
  }

  const screen =
    current === 'orchestration'
      ? {
          headline: 'Let agents drive agents?',
          description: caps
            ? `An agent may spawn and drive other panes — up to ${caps.max_live_children} live children, nested ${caps.max_spawn_depth} deep. Settings → Orchestration turns it back off.`
            : 'An agent may spawn and drive other panes. Settings → Orchestration turns it back off.',
          action: {
            label: 'Enable spawning',
            onClick: onEnableOrchestration
          },
          glyph: IconGitFork
        }
      : null

  if (!screen) return null

  return (
    <div
      data-testid="first-run"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full overflow-y-auto flex flex-col items-center justify-center p-[28px] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <EmptyState
        testId={`first-run-${current}`}
        headline={screen.headline}
        description={screen.description}
        action={screen.action}
        icon={
          <span className="flex h-[50px] w-[50px] items-center justify-center rounded-[10px] border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)]">
            <Icon glyph={screen.glyph} role="title" />
          </span>
        }
      />
      {footer}
    </div>
  )
}
