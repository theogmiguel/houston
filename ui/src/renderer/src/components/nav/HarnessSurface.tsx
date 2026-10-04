import { useEffect, useRef, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { Cadence } from '../../houston/generated/Cadence'
import type { HarnessFindingState } from '../../houston/generated/HarnessFindingState'
import type { HarnessModelOption } from '../../houston/generated/HarnessModelOption'
import type { Routine } from '../../houston/generated/Routine'
import type { HarnessAttention } from '../../houston/generated/HarnessAttention'
import type { HarnessReport, HarnessReportError, HarnessState } from '../../houston/useHarness'
import { Select } from '../Select'
import { BarSparkline, Button, Caption, Notice, PageFrame, PageHeader } from '../ui'
import { engineLabel } from '../engineLabel'
import { HarnessFindings } from './HarnessFindings'
import { HarnessReviewHistory } from './HarnessReviewHistory'
import {
  BLOCK,
  FIELD_INPUT,
  FIELD_LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  chipClass
} from './navChrome'
import {
  HARNESS_ENGINES,
  SCHEDULE_OPTIONS,
  scheduleFields,
  type HarnessSchedule
} from './harnessFormat'
import { formatCadence, nextUpTimeLabel } from './routineFormat'

const TEXT_CLS =
  '[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-secondary)]'

export interface HarnessSetupValue {
  engine: AgentKind
  model: string | null
  cadence: Cadence
  enabled: boolean
}

export interface HarnessSurfaceProps {
  workspaces: { id: string; name: string }[]
  workspace: string | null
  onWorkspace: (id: string) => void
  state: HarnessState | null
  report: HarnessReport | null
  reportError?: HarnessReportError | null
  running: boolean
  error?: string | null
  onDismissError?: () => void
  onCreateRoutine: (setup: HarnessSetupValue) => void
  onRunNow: (routineId: number) => void
  onDecide: (key: string, state: HarnessFindingState) => void
  attention?: HarnessAttention | null
  onSeen: (workspace: string, reviewId: number) => void
  onCreateTask: (key: string, engine: AgentKind, prompt: string) => void
  onLoadReport: (reviewId: number) => void
  onOpenFile: (path: string) => void
  onReveal: (path: string) => void
}

export function HarnessSurface(props: HarnessSurfaceProps): React.JSX.Element {
  const { state, onRunNow } = props
  // A first review runs as soon as the routine it creates is listed.
  const pendingRun = useRef<string | null>(null)
  useEffect(() => {
    if (state?.routine && pendingRun.current === state.workspace) {
      pendingRun.current = null
      onRunNow(state.routine.id)
    }
  }, [state, onRunNow])

  return (
    <PageFrame width="wide" data-testid="nav-surface">
      <HarnessHeader {...props} routine={props.workspace ? (state?.routine ?? null) : null} />
      <HarnessWorkspaceContent props={props} pendingRun={pendingRun} />
    </PageFrame>
  )
}

function HarnessHeader({
  workspace,
  state,
  running,
  routine,
  attention,
  onRunNow,
  onSeen,
  error,
  onDismissError
}: HarnessSurfaceProps & { routine: Routine | null }): React.JSX.Element {
  const noticeReviewId = attention?.latest_published_review_id ?? null
  const noticeVisible = noticeReviewId !== null && noticeReviewId > (attention?.seen_review_id ?? 0)
  const noticeFindings = state?.findings ?? []
  const newCount = noticeFindings.filter((finding) => finding.review_id === noticeReviewId && !finding.task).length
  const verifiedCount = noticeFindings.filter((finding) => finding.verification?.review_id === noticeReviewId && finding.verification.verdict === 'gone').length
  return (
    <>
      {noticeVisible && workspace && state && (
        <Notice tone="info" indicator="dot" action={{ label: 'Dismiss', onClick: () => onSeen(workspace, noticeReviewId) }}>
          Review #{noticeReviewId} found {newCount} new {newCount === 1 ? 'thing' : 'things'} to fix and confirmed {verifiedCount} fix{verifiedCount === 1 ? '' : 'es'} worked.
        </Notice>
      )}
      <PageHeader
        heading="Harness"
        description="Reads your agents' sessions and turns repeated mistakes into tasks. The next review checks whether each fix worked."
        actions={routine ? <Button data-testid="harness-run" variant="primary" disabled={running} onClick={() => onRunNow(routine.id)}>{running ? 'Review running…' : 'Run review now'}</Button> : undefined}
      />
      {error && <Notice tone="danger" className="w-full" action={{ label: 'Dismiss', onClick: onDismissError ?? (() => {}) }}>{error}</Notice>}
    </>
  )
}

function HarnessWorkspaceContent({
  props,
  pendingRun
}: {
  props: HarnessSurfaceProps
  pendingRun: React.MutableRefObject<string | null>
}): React.JSX.Element {
  const { workspace, state, workspaces } = props
  if (!workspace) {
    return (
      <div className="grid gap-[var(--space-2)]">
        <p>{workspaces.length ? 'Choose a workspace to see its Harness reviews.' : 'Add a workspace to review its agent sessions.'}</p>
        {workspaces.length > 0 && <Select aria-label="Workspace" data-testid="harness-workspace" value="" options={[{ value: '', label: 'Choose a workspace', disabled: true }, ...workspaces.map((item) => ({ value: item.id, label: item.name }))]} onChange={props.onWorkspace} />}
      </div>
    )
  }
  if (!state) return <p role="status" aria-busy="true">Reading this workspace&apos;s reviews…</p>
  if (!state.routine) {
    return <FirstRun models={state.models} onStart={(value) => { pendingRun.current = workspace; props.onCreateRoutine(value) }} />
  }
  const published = state.reviews.filter((review) => review.status === 'published')
  const trend = published.slice(0, 4).reverse().map((review) =>
    review.sessions ? Math.round((review.finding_count * 100) / review.sessions) : 0
  )
  return <HarnessBody {...props} state={state} routine={state.routine} published={published} latestReview={published[0] ?? null} trend={trend} />
}

function FirstRun({
  onStart,
  models
}: {
  onStart: (setup: HarnessSetupValue) => void
  models: HarnessModelOption[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[14px]" data-testid="harness-first-run">
      <p className={TEXT_CLS}>
        A harness review reads this workspace&apos;s recent agent sessions, compares them with its
        instructions, rules, skills and settings, and recommends what to change. It never edits them.
      </p>
      <WhatARunSends />
      <div className={`${BLOCK} p-[14px]`}>
        <SetupFields
          models={models}
          initial={{
            engine: 'claude',
            model: null,
            schedule: 'off',
            cadence: null
          }}
          submitLabel="Run first review"
          onSubmit={onStart}
        />
      </div>
    </div>
  )
}

function WhatARunSends(): React.JSX.Element {
  return (
    <section className={`${BLOCK} p-[14px] flex flex-col gap-[6px]`} data-testid="harness-consent">
      <h3 className="[font-size:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">
        What a review sends to its provider
      </h3>
      <ul className={`${TEXT_CLS} list-disc pl-[18px] flex flex-col gap-[2px]`}>
        <li>
          The harness files: CLAUDE.md, AGENTS.md, rules, skills, settings, hooks and MCP configuration.
        </li>
        <li>
          Excerpts of this workspace&apos;s Claude Code and Codex sessions in the review window: your prompts,
          tool failures, permission denials with secrets masked, the skills and subagents used, and each
          session&apos;s last assistant message.
        </li>
      </ul>
      <p className={TEXT_CLS}>
        The run is an agent pane you can watch. It sends those excerpts through the chosen provider&apos;s own
        CLI, like any turn of that agent. The findings it publishes stay on this machine.
      </p>
    </section>
  )
}

function SetupFields({
  models,
  initial,
  submitLabel,
  onSubmit,
  onCancel
}: {
  models: HarnessModelOption[]
  initial: {
    engine: AgentKind
    model: string | null
    schedule: HarnessSchedule
    cadence: Cadence | null
  }
  submitLabel: string
  onSubmit: (value: HarnessSetupValue) => void
  onCancel?: () => void
}): React.JSX.Element {
  const [engine, setEngine] = useState<AgentKind>(initial.engine)
  const [model, setModel] = useState(initial.model ?? '')
  const [schedule, setSchedule] = useState<HarnessSchedule>(initial.schedule)
  const catalogProvider = engine === 'claude' || engine === 'codex'
  const availableModels = models.filter((entry) => entry.provider === engine)
  const modelOptions = [
    { value: '', label: "The provider's default" },
    ...availableModels.map(({ id }) => ({ value: id, label: id })),
    ...(model && !availableModels.some(({ id }) => id === model)
      ? [{ value: model, label: `${model} (saved)` }]
      : [])
  ]
  return (
    <form
      className="flex flex-col gap-[12px]"
      onSubmit={(e) => {
        e.preventDefault()
        const fields =
          schedule === 'custom' && initial.cadence
            ? { cadence: initial.cadence, enabled: true }
            : scheduleFields(schedule === 'custom' ? 'off' : schedule, initial.cadence)
        onSubmit({ engine, model: model.trim() || null, ...fields })
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-[12px]">
        <div className="flex flex-col min-w-0">
          <span className={FIELD_LABEL}>Provider</span>
          <Select
            aria-label="Provider"
            data-testid="harness-provider"
            className="w-full"
            value={engine}
            options={HARNESS_ENGINES.map((k) => ({
              value: k,
              label: engineLabel(k)
            }))}
            onChange={(v) => {
              setEngine(v as AgentKind)
              setModel('')
            }}
          />
        </div>
        <div className="flex flex-col min-w-0">
          <span className={FIELD_LABEL}>Model</span>
          {catalogProvider ? (
            <Select
              aria-label="Model"
              data-testid="harness-model"
              className="w-full"
              value={model}
              options={modelOptions}
              onChange={setModel}
            />
          ) : (
            <input
              aria-label="Model"
              id="harness-model"
              className={`${FIELD_INPUT} w-full`}
              autoComplete="off"
              value={model}
              placeholder="The provider's default"
              onChange={(e) => setModel(e.target.value)}
            />
          )}
        </div>
      </div>
      {catalogProvider && (
        <p className={TEXT_CLS}>
          Models come from Houston's shared catalog. Availability depends on your provider account.
        </p>
      )}
      <div className="flex flex-col">
        <span className={FIELD_LABEL}>Schedule</span>
        <div className="flex flex-col gap-[6px]">
          <div role="group" aria-label="Schedule" className="flex flex-wrap gap-[6px]">
            {SCHEDULE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={schedule === o.value}
                className={chipClass(schedule === o.value)}
                onClick={() => setSchedule(o.value)}
              >
                {o.label}
              </button>
            ))}
            {initial.schedule === 'custom' && initial.cadence && (
              <button
                type="button"
                aria-pressed={schedule === 'custom'}
                className={chipClass(schedule === 'custom')}
                onClick={() => setSchedule('custom')}
              >
                Keep {formatCadence(initial.cadence)}
              </button>
            )}
          </div>
          <p className={TEXT_CLS}>
            Every run spends tokens. A scheduled run reads from where the previous review stopped.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-[8px]">
        <button type="submit" className={PRIMARY_BUTTON}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

function HarnessBody(
  props: HarnessSurfaceProps & {
    state: HarnessState
    routine: Routine
    published: HarnessState['reviews']
    latestReview: HarnessState['reviews'][number] | null
    trend: number[]
  }
): React.JSX.Element {
  const { state, routine, latestReview, published, trend } = props
  const firstValue = trend[0] ?? 0
  const lastValue = trend[trend.length - 1] ?? 0
  const coverage = state.providerCoverage.reduce((sum, item) => sum + item.sessions, 0)
  const unscanned = state.providerCoverage.map((item) => `${item.sessions} ${engineLabel(item.agent)} sessions`).join(', ')
  return (
    <div className="grid gap-[var(--space-2)]">
      {published.length === 0 && <WhatARunSends />}
      <div className="flex min-w-0 items-center gap-[var(--space-2)]">
        <BarSparkline values={trend} label={`Repeated mistakes per 100 sessions: ${firstValue} to ${lastValue}`} />
        <Caption className="min-w-0">
          Repeated mistakes per 100 sessions: {firstValue} → {lastValue} over {published.length} reviews
          {latestReview && <> · last review #{latestReview.id} {reviewTime(latestReview.started_at_ms)}, {latestReview.sessions ?? 0} sessions</>}
          {routine.enabled && <> · next {nextUpTimeLabel(routine.next_run_at_ms, Date.now())}</>}
        </Caption>
      </div>
      <HarnessFindings
        workspace={state.workspace}
        findings={state.findings}
        defaultEngine={routine.engine}
        latestReviewId={latestReview?.id ?? null}
        latestReviewSessions={latestReview?.sessions ?? null}
        onDecide={props.onDecide}
        onCreateTask={props.onCreateTask}
        onVerifyNow={() => props.onRunNow(routine.id)}
      />
      <HarnessReviewHistory
        state={state}
        report={props.report}
        reportError={props.reportError ?? null}
        onLoadReport={props.onLoadReport}
        onOpenFile={props.onOpenFile}
        onReveal={props.onReveal}
      />
      <Caption>
        Read: Claude Code, Codex. {coverage ? `Not read: ${unscanned} in this window.` : 'All sessions in this window were read.'}
      </Caption>
    </div>
  )
}

function reviewTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
