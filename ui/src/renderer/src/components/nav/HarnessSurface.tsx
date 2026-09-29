import { useEffect, useRef, useState } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { Cadence } from '../../houston/generated/Cadence'
import type { HarnessFindingState } from '../../houston/generated/HarnessFindingState'
import type { HarnessModelOption } from '../../houston/generated/HarnessModelOption'
import type { Routine } from '../../houston/generated/Routine'
import type { RoutineMutation } from '../../houston/routineTypes'
import type { HarnessReport, HarnessReportError, HarnessState } from '../../houston/useHarness'
import { MATERIAL_CLS, materialAttrs } from '../material'
import { Segmented } from '../Segmented'
import { Select } from '../Select'
import { engineLabel } from '../engineLabel'
import { SectionHead } from '../settingsPrimitives'
import { HarnessFindings } from './HarnessFindings'
import { HarnessHistory } from './HarnessHistory'
import { HarnessReportView } from './HarnessReportView'
import {
  BLOCK,
  FIELD_INPUT,
  FIELD_LABEL,
  NavColumn,
  NavFeedback,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  chipClass
} from './navChrome'
import {
  HARNESS_ENGINES,
  SCHEDULE_OPTIONS,
  scheduleFields,
  scheduleLabel,
  scheduleOf,
  type HarnessSchedule
} from './harnessFormat'
import { formatCadence } from './routineFormat'

type Tab = 'findings' | 'history' | 'report'

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
  liveSessions: { has(id: number): boolean }
  error?: string | null
  onDismissError?: () => void
  onCreateRoutine: (setup: HarnessSetupValue) => void
  onUpdateRoutine: (mutation: RoutineMutation) => void
  onRunNow: (routineId: number) => void
  onDecide: (key: string, state: HarnessFindingState) => void
  onLoadReport: (reviewId: number) => void
  onOpenSession: (sessionId: number) => void
  onOpenFile: (path: string) => void
  onReveal: (path: string) => void
  onPrepareFix: (engine: AgentKind, prompt: string) => void
}

export function HarnessSurface(props: HarnessSurfaceProps): React.JSX.Element {
  const { workspaces, workspace, onWorkspace, state, running, onRunNow } = props
  const [scheduling, setScheduling] = useState(false)
  const routine = workspace ? (state?.routine ?? null) : null
  useEffect(() => setScheduling(false), [workspace])
  // A first review runs as soon as the routine it creates is listed.
  const pendingRun = useRef<string | null>(null)
  useEffect(() => {
    if (state?.routine && pendingRun.current === state.workspace) {
      pendingRun.current = null
      onRunNow(state.routine.id)
    }
  }, [state, onRunNow])
  return (
    <div
      data-testid="nav-surface"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full min-h-0 overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <NavColumn wide>
        <SectionHead
          title="Harness review"
          lede={routine ? scheduleLabel(routine) : undefined}
          actions={
            <>
              <Select
                aria-label="Workspace"
                data-testid="harness-workspace"
                value={workspace ?? ''}
                options={[
                  ...(workspace
                    ? []
                    : [
                        {
                          value: '',
                          label: 'Choose a workspace',
                          disabled: true
                        }
                      ]),
                  ...workspaces.map((w) => ({ value: w.id, label: w.name }))
                ]}
                onChange={onWorkspace}
              />
              {routine && (
                <>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    aria-expanded={scheduling}
                    onClick={() => setScheduling((v) => !v)}
                  >
                    Schedule
                  </button>
                  <button
                    type="button"
                    data-testid="harness-run"
                    className={PRIMARY_BUTTON}
                    disabled={running}
                    onClick={() => onRunNow(routine.id)}
                  >
                    {running ? 'Review running…' : 'Run review'}
                  </button>
                </>
              )}
            </>
          }
        />
        <div className="flex flex-col gap-[14px]">
          {props.error && (
            <NavFeedback tone="error" onDismiss={props.onDismissError} testId="harness-error">
              {props.error}
            </NavFeedback>
          )}
          {routine && scheduling && (
            <SchedulePanel {...props} routine={routine} onClose={() => setScheduling(false)} />
          )}
          {!workspace ? (
            <p className={TEXT_CLS}>Choose the workspace whose agent sessions and harness to review.</p>
          ) : !state ? (
            <p className={TEXT_CLS} role="status" aria-busy>
              Reading this workspace&apos;s reviews…
            </p>
          ) : !state.routine ? (
            <FirstRun
              models={state.models}
              onStart={(v) => {
                pendingRun.current = workspace
                props.onCreateRoutine(v)
              }}
            />
          ) : (
            <HarnessBody {...props} state={state} routine={state.routine} />
          )}
        </div>
      </NavColumn>
    </div>
  )
}

function SchedulePanel(
  props: HarnessSurfaceProps & { routine: Routine; onClose: () => void }
): React.JSX.Element {
  const { routine, onClose, onUpdateRoutine } = props
  return (
    <div className={`${BLOCK} p-[14px]`} data-testid="harness-schedule">
      <SetupFields
        models={props.state?.models ?? []}
        initial={{
          engine: routine.engine,
          model: routine.model ?? null,
          schedule: scheduleOf(routine),
          cadence: routine.cadence
        }}
        submitLabel="Save schedule"
        onCancel={onClose}
        onSubmit={(v) => {
          onUpdateRoutine({
            id: routine.id,
            expected_revision: routine.revision,
            engine: v.engine,
            model: v.model,
            cadence: v.cadence,
            enabled: v.enabled
          })
          onClose()
        }}
      />
    </div>
  )
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
  props: HarnessSurfaceProps & { state: HarnessState; routine: Routine }
): React.JSX.Element {
  const { state, routine, report } = props
  const [tab, setTab] = useState<Tab>('findings')
  const neverRan = state.reviews.length === 0
  return (
    <div className="flex flex-col gap-[12px]">
      {neverRan && <WhatARunSends />}
      <Segmented<Tab>
        aria-label="Harness view"
        value={tab}
        onChange={setTab}
        options={[
          {
            value: 'findings',
            label: 'Findings',
            testId: 'harness-tab-findings'
          },
          {
            value: 'history',
            label: 'Run history',
            testId: 'harness-tab-history'
          },
          {
            value: 'report',
            label: 'Full report',
            testId: 'harness-tab-report'
          }
        ]}
      />
      {tab === 'findings' ? (
        <HarnessFindings
          workspace={state.workspace}
          findings={state.findings}
          defaultEngine={routine.engine}
          onDecide={props.onDecide}
          onOpenFile={props.onOpenFile}
          onPrepareFix={props.onPrepareFix}
        />
      ) : tab === 'history' ? (
        <HarnessHistory
          reviews={state.reviews}
          liveSessions={props.liveSessions}
          onOpenSession={props.onOpenSession}
        />
      ) : (
        <HarnessReportView
          reviews={state.reviews}
          report={report}
          reportError={props.reportError ?? null}
          onLoadReport={props.onLoadReport}
          onOpenFile={props.onOpenFile}
          onReveal={props.onReveal}
        />
      )}
    </div>
  )
}
