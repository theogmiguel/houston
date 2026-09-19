import { useState } from 'react'
import { Select } from '../Select'
import { Segmented } from '../Segmented'
import { Toggle } from '../settingsPrimitives'
import {
  FIELD_INPUT,
  FIELD_LABEL,
  FIELD_TEXTAREA,
  NavFeedback,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  chipClass
} from './navChrome'
import type { Cadence, RoutineWorkspaceOption } from '../../houston/routineTypes'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { ChatEffort } from '../../houston/generated/ChatEffort'
import type { ChatPermissionMode } from '../../houston/generated/ChatPermissionMode'
import { ENGINE_ORDER, engineLabel } from '../engineLabel'
import { CHAT_EFFORTS } from '../agentOptions'

export type RoutineFormValue = {
  engine: AgentKind
  model: string | null
  effort: ChatEffort | null
  name: string
  prompt: string
  cadence: Cadence
  workspaceId: string | null
  permissionMode: ChatPermissionMode
  isolate: boolean
}

const WEEKDAYS_MON_FRI = [2, 3, 4, 5, 6]
const EFFORT_ENGINES: AgentKind[] = ['claude', 'codex', 'antigravity', 'grok']

function supportsEffort(engine: AgentKind): boolean {
  return EFFORT_ENGINES.includes(engine)
}

/// One-line hint under a field in this form.
const FIELD_HINT_CLS =
  '-mt-[2px] mb-[8px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] [line-height:var(--tr-text-small-leading)] text-[var(--text-faint)]'

const PRESETS: { label: string; cadence: Cadence }[] = [
  { label: 'Every 15 minutes', cadence: { type: 'interval', seconds: 900 } },
  { label: 'Hourly', cadence: { type: 'interval', seconds: 3600 } },
  { label: 'Daily 09:00', cadence: { type: 'clock', hour: 9, minute: 0, weekdays: null } },
  {
    label: 'Weekdays 09:00',
    cadence: { type: 'clock', hour: 9, minute: 0, weekdays: WEEKDAYS_MON_FRI }
  }
]

function cadenceEquals(a: Cadence, b: Cadence): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'interval' && b.type === 'interval') return a.seconds === b.seconds
  if (a.type === 'clock' && b.type === 'clock') {
    return (
      a.hour === b.hour &&
      a.minute === b.minute &&
      JSON.stringify(a.weekdays) === JSON.stringify(b.weekdays)
    )
  }
  return false
}

function presetIndexFor(cadence: Cadence): number {
  return PRESETS.findIndex((p) => cadenceEquals(p.cadence, cadence))
}

function initialFormState(initial: RoutineFormValue | undefined): RoutineFormValue & {
  customOpen: boolean
} {
  const empty: RoutineFormValue = {
    engine: 'claude',
    model: null,
    effort: null,
    name: '',
    prompt: '',
    workspaceId: null,
    permissionMode: 'accept_edits',
    isolate: false,
    cadence: PRESETS[0].cadence
  }
  const value = initial ?? empty
  return {
    ...value,
    customOpen: initial !== undefined && presetIndexFor(value.cadence) === -1
  }
}

function Field({
  label,
  htmlFor,
  children
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="min-w-0 [&+&]:mt-[18px]">
      {htmlFor ? (
        <label className={FIELD_LABEL} htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className={FIELD_LABEL}>{label}</span>
      )}
      {children}
    </div>
  )
}

function CustomCadenceEditor({
  cadence,
  onChange
}: {
  cadence: Cadence
  onChange: (cadence: Cadence) => void
}): React.JSX.Element {
  return (
    <div className="mt-[10px] flex items-center gap-[8px]">
      {cadence.type === 'interval' ? (
        <>
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">every</span>
          <input
            type="number"
            min={1}
            aria-label="Interval in seconds"
            className={`${FIELD_INPUT} w-[100px]`}
            value={cadence.seconds}
            onChange={(e) =>
              onChange({
                type: 'interval',
                seconds: Math.max(1, Math.trunc(Number(e.target.value)) || 1)
              })
            }
          />
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">seconds</span>
          <button
            type="button"
            className="btn ml-auto border-0 bg-transparent p-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] underline cursor-pointer hover:text-[var(--text-primary)]"
            onClick={() => onChange({ type: 'clock', hour: 9, minute: 0, weekdays: null })}
          >
            switch to clock
          </button>
        </>
      ) : (
        <>
          <input
            type="number"
            min={0}
            max={23}
            aria-label="Hour"
            className={`${FIELD_INPUT} w-[68px]`}
            value={cadence.hour}
            onChange={(e) =>
              onChange({
                ...cadence,
                hour: Math.min(23, Math.max(0, Math.trunc(Number(e.target.value)) || 0))
              })
            }
          />
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">:</span>
          <input
            type="number"
            min={0}
            max={59}
            aria-label="Minute"
            className={`${FIELD_INPUT} w-[68px]`}
            value={cadence.minute}
            onChange={(e) =>
              onChange({
                ...cadence,
                minute: Math.min(59, Math.max(0, Math.trunc(Number(e.target.value)) || 0))
              })
            }
          />
          <Segmented
            aria-label="Which days"
            value={cadence.weekdays === null ? 'daily' : 'weekdays'}
            onChange={(v) =>
              onChange({ ...cadence, weekdays: v === 'daily' ? null : WEEKDAYS_MON_FRI })
            }
            options={[
              { value: 'daily', label: 'Daily' },
              { value: 'weekdays', label: 'Weekdays' }
            ]}
          />
          <button
            type="button"
            className="btn ml-auto border-0 bg-transparent p-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] underline cursor-pointer hover:text-[var(--text-primary)]"
            onClick={() => onChange({ type: 'interval', seconds: 900 })}
          >
            switch to interval
          </button>
        </>
      )}
    </div>
  )
}

function RoutineEditorFooter({
  mode,
  initialName,
  canSubmit,
  onCancel
}: {
  mode: 'create' | 'edit'
  initialName?: string
  canSubmit: boolean
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="flex-none flex items-center gap-[8px] min-h-[54px] px-[16px] py-[10px] border-t border-[var(--divider)]">
      <span className="flex-1 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">
        {mode === 'create'
          ? 'Nothing is saved until you create it.'
          : `Editing “${initialName}”. Every run is independent.`}
      </span>
      <button type="button" className={`${SECONDARY_BUTTON} min-w-[84px]`} onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" disabled={!canSubmit} className={`${PRIMARY_BUTTON} min-w-[128px]`}>
        {mode === 'create' ? 'Create routine' : 'Save changes'}
      </button>
    </div>
  )
}

export function RoutineEditor(props: {
  mode: 'create' | 'edit'
  workspaces: RoutineWorkspaceOption[]
  initial?: RoutineFormValue
  error?: string | null
  onSubmit: (value: RoutineFormValue) => void
  onCancel: () => void
}): React.JSX.Element {
  const { mode, workspaces, initial, error, onSubmit, onCancel } = props
  const initialState = initialFormState(initial)
  const [engine, setEngine] = useState<AgentKind>(initialState.engine)
  const [model, setModel] = useState<string | null>(initialState.model)
  const [effort, setEffort] = useState<ChatEffort | null>(initialState.effort)
  const [name, setName] = useState(initialState.name)
  const [prompt, setPrompt] = useState(initialState.prompt)
  const [workspaceId, setWorkspaceId] = useState<string | null>(initialState.workspaceId)
  const [cadence, setCadence] = useState<Cadence>(initialState.cadence)
  const [permissionMode, setPermissionMode] = useState<ChatPermissionMode>(
    initialState.permissionMode
  )
  const [isolate, setIsolate] = useState(initialState.isolate)
  const [customOpen, setCustomOpen] = useState(initialState.customOpen)
  const selectedPreset = customOpen ? -1 : presetIndexFor(cadence)

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && trimmedName.length <= 160

  function submit(): void {
    if (!canSubmit) return
    onSubmit({
      engine,
      model,
      effort,
      name: trimmedName,
      prompt,
      cadence,
      workspaceId,
      permissionMode,
      isolate: isolate && workspaceId !== null
    })
  }

  return (
    <form
      data-testid="routine-editor"
      className="flex-1 min-h-0 flex flex-col overflow-hidden"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="flex-1 min-h-0 overflow-y-auto px-[max(22px,calc(50%-320px))] py-[22px]">
        <Field label="Name" htmlFor="routine-name">
          <input
            id="routine-name"
            className={FIELD_INPUT}
            autoComplete="off"
            value={name}
            maxLength={160}
            placeholder="Leak watch"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field label="When it fires, do this" htmlFor="routine-prompt">
          <textarea
            id="routine-prompt"
            className={FIELD_TEXTAREA}
            value={prompt}
            maxLength={64_000}
            placeholder="What each run is told to do."
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <Field label="Cadence">
          <div className="flex flex-wrap gap-[6px]">
            {PRESETS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                aria-pressed={selectedPreset === i}
                className={chipClass(selectedPreset === i)}
                onClick={() => {
                  setCustomOpen(false)
                  setCadence(p.cadence)
                }}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={customOpen}
              className={chipClass(customOpen)}
              onClick={() => setCustomOpen(true)}
            >
              Custom
            </button>
          </div>

          {customOpen && <CustomCadenceEditor cadence={cadence} onChange={setCadence} />}
        </Field>

        <Field label="Working directory">
          <Select
            className="w-full h-[36px]"
            aria-label="Working directory"
            value={workspaceId ?? ''}
            options={[
              { value: '', label: 'No specific directory' },
              ...workspaces.map((w) => ({ value: w.id, label: w.name }))
            ]}
            onChange={(v) => setWorkspaceId(v === '' ? null : v)}
          />
          <p className={FIELD_HINT_CLS}>
            Where each run starts. A run with no directory is refused, not guessed at.
          </p>
        </Field>

        <Field label="Runs on">
          <Select
            className="w-full h-[36px]"
            aria-label="Engine"
            value={engine}
            options={ENGINE_ORDER.map((k) => ({ value: k, label: engineLabel(k) }))}
            onChange={(v) => {
              setEngine(v as AgentKind)
              setModel(null)
              setEffort(null)
            }}
          />
          <p className={FIELD_HINT_CLS}>
            The provider every run executes with, as its own terminal pane.
          </p>
        </Field>

        <Field label="Model">
          <input
            className={FIELD_INPUT}
            aria-label="Model"
            value={model ?? ''}
            placeholder="CLI default"
            onChange={(e) => setModel(e.target.value === '' ? null : e.target.value)}
          />
          <p className={FIELD_HINT_CLS}>Optional provider model ID. Empty follows the CLI default.</p>
        </Field>

        {supportsEffort(engine) && (
          <Field label="Reasoning effort">
            <Select
              className="w-full h-[36px]"
              aria-label="Reasoning effort"
              value={effort ?? ''}
              options={CHAT_EFFORTS.map((e) => ({ value: e.value ?? '', label: e.title }))}
              onChange={(v) => setEffort(v === '' ? null : (v as ChatEffort))}
            />
          </Field>
        )}

        <Field label="Access">
          <Select
            className="w-full h-[36px]"
            aria-label="Access"
            value={permissionMode}
            options={[
              { value: 'accept_edits', label: 'Accept edits — everything else is denied' },
              {
                value: 'bypass_permissions',
                label: 'Full access — the run never asks (needs isolation)'
              }
            ]}
            onChange={(v) => setPermissionMode(v as ChatPermissionMode)}
          />
          <p className={FIELD_HINT_CLS}>
            There is no “Automatic” here: that means “every risky step asks”, and a run has
            nobody to ask. A prompt raised anyway is denied and written into the run record.
          </p>
        </Field>

        <Field label="Isolation">
          <div className="flex items-center gap-[12px] min-h-[42px] px-[12px] py-[8px] rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--content-bg)]">
            <span className="flex-1 min-w-0 [font-size:var(--tr-text-small-size)] text-[var(--text-secondary)]">
              Run in a fresh worktree of the working directory
            </span>
            <Toggle
              data-testid="routine-isolate"
              on={isolate}
              disabled={workspaceId === null}
              onChange={(v) => {
                setIsolate(v)
                if (!v && permissionMode === 'bypass_permissions') {
                  setPermissionMode('accept_edits')
                }
              }}
            />
          </div>
          <p className={FIELD_HINT_CLS}>
            {workspaceId === null
              ? 'Pick a working directory first — a worktree needs a git repository to branch from.'
              : 'Houston makes the worktree and lists it under the run; it never merges. Full access requires this, so a run that never asks cannot land in the tree you are editing.'}
          </p>
        </Field>

        {error && (
          <div className="mt-[18px]">
            <NavFeedback tone="error" testId="routine-error">
              {error}
            </NavFeedback>
          </div>
        )}
      </div>

      <RoutineEditorFooter
        mode={mode}
        initialName={initial?.name}
        canSubmit={canSubmit}
        onCancel={onCancel}
      />
    </form>
  )
}
