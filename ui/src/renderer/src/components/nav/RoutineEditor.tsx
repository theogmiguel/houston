import { useState } from 'react'
import { Segmented } from '../ui/SegmentedControl'
import { Toggle } from '../ui/settingsPrimitives'
import { FeedbackBanner } from '../ui/navPrimitives'
import { Text } from '../ui/Text'
import {
  ChipGroup,
  ChoiceChip,
  FieldActionButton,
  FormField,
  FormHint,
  FieldControl,
  FormPanel,
  FormPanelBody,
  FormPanelFooter,
  FormSelect,
  FormSubRow,
  FormTextarea,
  FormToggleRow,
  InlineLinkButton
} from '../ui/formPrimitives'
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

function CustomCadenceEditor({
  cadence,
  onChange
}: {
  cadence: Cadence
  onChange: (cadence: Cadence) => void
}): React.JSX.Element {
  return (
    <FormSubRow>
      {cadence.type === 'interval' ? (
        <>
          <Text size="small" weight="small" tone="secondary">every</Text>
          <FieldControl
            type="number"
            min={1}
            aria-label="Interval in seconds"
            width="md"
            value={cadence.seconds}
            onChange={(e) =>
              onChange({
                type: 'interval',
                seconds: Math.max(1, Math.trunc(Number(e.target.value)) || 1)
              })
            }
          />
          <Text size="small" weight="small" tone="secondary">seconds</Text>
          <InlineLinkButton
            onClick={() => onChange({ type: 'clock', hour: 9, minute: 0, weekdays: null })}
          >
            switch to clock
          </InlineLinkButton>
        </>
      ) : (
        <>
          <FieldControl
            type="number"
            min={0}
            max={23}
            aria-label="Hour"
            width="sm"
            value={cadence.hour}
            onChange={(e) =>
              onChange({
                ...cadence,
                hour: Math.min(23, Math.max(0, Math.trunc(Number(e.target.value)) || 0))
              })
            }
          />
          <Text size="small" weight="small" tone="secondary">:</Text>
          <FieldControl
            type="number"
            min={0}
            max={59}
            aria-label="Minute"
            width="sm"
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
          <InlineLinkButton
            onClick={() => onChange({ type: 'interval', seconds: 900 })}
          >
            switch to interval
          </InlineLinkButton>
        </>
      )}
    </FormSubRow>
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
    <FormPanelFooter
      note={
        mode === 'create'
          ? 'Nothing is saved until you create it.'
          : `Editing “${initialName}”. Every run is independent.`
      }
    >
      <FieldActionButton minWidth="sm" onClick={onCancel}>
        Cancel
      </FieldActionButton>
      <FieldActionButton tone="primary" type="submit" minWidth="md" disabled={!canSubmit}>
        {mode === 'create' ? 'Create routine' : 'Save changes'}
      </FieldActionButton>
    </FormPanelFooter>
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
    <FormPanel
      data-testid="routine-editor"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <FormPanelBody>
        <FormField label="Name" htmlFor="routine-name">
          <FieldControl
            id="routine-name"
            autoComplete="off"
            value={name}
            maxLength={160}
            placeholder="Leak watch"
            onChange={(e) => setName(e.target.value)}
          />
        </FormField>

        <FormField label="When it fires, do this" htmlFor="routine-prompt">
          <FormTextarea
            id="routine-prompt"
            value={prompt}
            maxLength={64_000}
            placeholder="What each run is told to do."
            onChange={(e) => setPrompt(e.target.value)}
          />
        </FormField>

        <FormField label="Cadence">
          <ChipGroup>
            {PRESETS.map((p, i) => (
              <ChoiceChip
                key={p.label}
                pressed={selectedPreset === i}
                onClick={() => {
                  setCustomOpen(false)
                  setCadence(p.cadence)
                }}
              >
                {p.label}
              </ChoiceChip>
            ))}
            <ChoiceChip pressed={customOpen} onClick={() => setCustomOpen(true)}>
              Custom
            </ChoiceChip>
          </ChipGroup>

          {customOpen && <CustomCadenceEditor cadence={cadence} onChange={setCadence} />}
        </FormField>

        <FormField label="Working directory">
          <FormSelect
            aria-label="Working directory"
            value={workspaceId ?? ''}
            options={[
              { value: '', label: 'No specific directory' },
              ...workspaces.map((w) => ({ value: w.id, label: w.name }))
            ]}
            onChange={(v) => setWorkspaceId(v === '' ? null : v)}
          />
          <FormHint>
            Where each run starts. A run with no directory is refused, not guessed at.
          </FormHint>
        </FormField>

        <FormField label="Runs on">
          <FormSelect
            aria-label="Engine"
            value={engine}
            options={ENGINE_ORDER.map((k) => ({ value: k, label: engineLabel(k) }))}
            onChange={(v) => {
              setEngine(v as AgentKind)
              setModel(null)
              setEffort(null)
            }}
          />
          <FormHint>
            The provider every run executes with, as its own terminal pane.
          </FormHint>
        </FormField>

        <FormField label="Model">
          <FieldControl
            aria-label="Model"
            value={model ?? ''}
            placeholder="CLI default"
            onChange={(e) => setModel(e.target.value === '' ? null : e.target.value)}
          />
          <FormHint>Optional provider model ID. Empty follows the CLI default.</FormHint>
        </FormField>

        {supportsEffort(engine) && (
          <FormField label="Reasoning effort">
            <FormSelect
              aria-label="Reasoning effort"
              value={effort ?? ''}
              options={CHAT_EFFORTS.map((e) => ({ value: e.value ?? '', label: e.title }))}
              onChange={(v) => setEffort(v === '' ? null : (v as ChatEffort))}
            />
          </FormField>
        )}

        <FormField label="Access">
          <FormSelect
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
          <FormHint>
            There is no “Automatic” here: that means “every risky step asks”, and a run has
            nobody to ask. A prompt raised anyway is denied and written into the run record.
          </FormHint>
        </FormField>

        <FormField label="Isolation">
          <FormToggleRow label="Run in a fresh worktree of the working directory">
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
          </FormToggleRow>
          <FormHint>
            {workspaceId === null
              ? 'Pick a working directory first — a worktree needs a git repository to branch from.'
              : 'Houston makes the worktree and lists it under the run; it never merges. Full access requires this, so a run that never asks cannot land in the tree you are editing.'}
          </FormHint>
        </FormField>

        {error && (
          <FormField>
            <FeedbackBanner tone="error" testId="routine-error">
              {error}
            </FeedbackBanner>
          </FormField>
        )}
      </FormPanelBody>

      <RoutineEditorFooter
        mode={mode}
        initialName={initial?.name}
        canSubmit={canSubmit}
        onCancel={onCancel}
      />
    </FormPanel>
  )
}
