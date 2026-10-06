import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { TaskPromptDelivery } from '../../houston/generated/TaskPromptDelivery'
import type { TasksAccess } from '../../houston/generated/TasksAccess'
import { TASKS_REWORK_ROUNDS_MAX } from '../../houston/generated/DEFAULTS'
import { useTaskReviewSettings, useTaskStartSettings, useTasksAccess } from '../../houston/useTasks'
import { IconAgent } from '../icons'
import { Segmented } from '../ui/SegmentedControl'
import { Select, type SelectOption } from '../ui/Select'
import { SettingsList } from '../ui/settingsPrimitives'
import { SettingsScope } from '../ui/SettingsScope'
import { parseReworkRounds, TASK_AGENTS, taskAgentLabel } from '../tasks/format'
import { Row, SubHead } from './shared'

const ACCESS_LABEL: Readonly<Record<TasksAccess, string>> = {
  off: 'Off',
  read: 'Read only',
  write: 'Read and write'
}

const ACCESS_OPTIONS: { value: TasksAccess; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Read and write' }
]

/// Settings ▸ Tasks: agent access, the workspace's Start defaults, and review.
export function TasksSection({
  client,
  workspace,
  workspaceName
}: {
  client: HoustonClient | null
  workspace: string | null
  workspaceName: string | null
}): React.JSX.Element {
  const { access, setAccess } = useTasksAccess(client, workspace)
  const { settings, setStartSettings } = useTaskStartSettings(client, workspace)
  const { settings: review, refusal: reviewRefusal, setReviewSettings } = useTaskReviewSettings(client, workspace)
  const noWorkspaceReason = 'Select a single workspace in the sidebar to manage its task settings'

  return (
    <>
      <SettingsScope workspace={workspaceName} />
      <SubHead>Agent access · {workspaceName ?? 'no workspace selected'}</SubHead>
      <SettingsList>
        <AgentAccessRow
          access={access}
          workspace={workspace}
          noWorkspaceReason={noWorkspaceReason}
          onChange={setAccess}
        />
        <Row
          title="Task key prefix"
          desc={
            <span className="block">
              The fixed HOU prefix and globally unique number identify a task across workspaces.
            </span>
          }
        >
          <span className="inline-flex items-center h-[var(--h-ctl)] px-[var(--space-2)] border border-[var(--border)] rounded-[var(--tr-radius-button)] bg-[var(--content-bg)] font-mono text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)]">
            HOU
          </span>
        </Row>
      </SettingsList>
      <SubHead>Starting a task</SubHead>
      <SettingsList>
        <Row title="Default agent" desc={<><span>Used by Start. Pick another one from the Start menu.</span><SettingsScope workspace={workspaceName} row /></>}>
          <Select
            aria-label="Default agent"
            data-testid="settings-tasks-agent"
            value={settings?.agent ?? 'claude'}
            options={AGENT_OPTIONS}
            disabled={workspace === null || settings === null}
            prefix={<IconAgent agent={settings?.agent ?? 'claude'} brand className="w-3.5 h-3.5 flex-none" />}
            className="min-w-[120px]"
            onChange={(value) => setStartSettings(value as AgentKind, settings?.delivery ?? 'send')}
          />
        </Row>
        <Row
          title="Prompt delivery"
          desc={<><span>Send the brief when you press Start, or only place it in the input box.</span><SettingsScope workspace={workspaceName} row /></>}
        >
          <Segmented
            aria-label="Prompt delivery"
            value={settings?.delivery}
            loading={workspace !== null && settings === null}
            options={DELIVERY_OPTIONS.map((option) => ({
              ...option,
              disabled: workspace === null,
              disabledReason: workspace === null ? noWorkspaceReason : undefined,
              testId: `settings-tasks-delivery-${option.value}`
            }))}
            onChange={(value) => setStartSettings(settings?.agent ?? 'claude', value)}
          />
        </Row>
      </SettingsList>
      <SubHead>Review</SubHead>
      <SettingsList>
        <Row
          title="Independent reviewer"
          desc={<><span>Runs read-only in the same worktree when a task is handed back. Reports evidence; it does not mark a task done.</span><SettingsScope workspace={workspaceName} row /></>}
        >
          <Select
            aria-label="Independent reviewer"
            data-testid="settings-tasks-reviewer"
            value={review?.reviewer ?? 'none'}
            options={REVIEWER_OPTIONS}
            disabled={workspace === null || review === null}
            prefix={
              review?.reviewer != null ? (
                <IconAgent agent={review.reviewer} brand className="w-3.5 h-3.5 flex-none" />
              ) : undefined
            }
            className="min-w-[120px]"
            onChange={(value) =>
              setReviewSettings(value === 'none' ? null : (value as AgentKind), review?.reworkRounds ?? 0)
            }
          />
        </Row>
        <Row
          title="Automatic rework rounds"
          desc={<><span>How many times a failed review restarts the implementer on its own. 0 asks you first.</span><SettingsScope workspace={workspaceName} row /></>}
        >
          <ReworkRoundsInput
            value={review?.reworkRounds ?? null}
            disabled={workspace === null || review === null}
            onCommit={(rounds) => setReviewSettings(review?.reviewer ?? null, rounds)}
          />
        </Row>
      </SettingsList>
      {reviewRefusal !== null && (
        <div
          data-testid="settings-tasks-review-refusal"
          className="pt-[var(--space-2)] [font-size:var(--tr-text-small-size)] text-[var(--danger)]"
        >
          {reviewRefusal.message}
        </div>
      )}
    </>
  )
}

/// The agent-access row: the current value is always visible beside the control.
function AgentAccessRow({
  access,
  workspace,
  noWorkspaceReason,
  onChange
}: {
  access: TasksAccess | null
  workspace: string | null
  noWorkspaceReason: string
  onChange: (access: TasksAccess) => void
}): React.JSX.Element {
  return (
      <Row
        title="Agent access"
        desc={
          <span className="block">
            Agents can read the global backlog and write tasks assigned to this workspace or no
            workspace. Tasks of another workspace are read-only to agents. Children of an
            orchestrator never see the backlog; they get their brief.
            <span
              data-testid="settings-tasks-current"
              className="block pt-[6px] text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]"
            >
              Currently{' '}
              <b className="font-semibold text-[var(--text-primary)]">
                {access === null ? 'loading…' : ACCESS_LABEL[access]}
              </b>
            </span>
            <SettingsScope workspace={workspace} row />
          </span>
        }
      >
        <Segmented
          aria-label="Agent access"
          value={access ?? undefined}
          loading={workspace !== null && access === null}
          options={ACCESS_OPTIONS.map((option) => ({
            ...option,
            disabled: workspace === null,
            disabledReason: workspace === null ? noWorkspaceReason : undefined,
            testId: `settings-tasks-access-${option.value}`
          }))}
          onChange={(value) => onChange(value as TasksAccess)}
        />
      </Row>
  )
}

/// The rework-rounds field: the draft never reaches the daemon out of range —
/// the guard refuses it naming the cap, the requested value and the value the
/// setting keeps. The daemon's own refusal still surfaces above when it comes.
function ReworkRoundsInput({
  value,
  disabled,
  onCommit
}: {
  value: number | null
  disabled: boolean
  onCommit: (rounds: number) => void
}): React.JSX.Element {
  const current = value ?? 0
  const [draft, setDraft] = useState(String(current))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(String(current))
    setError(null)
  }, [current])
  const commit = (): void => {
    const parsed = parseReworkRounds(draft, current, TASKS_REWORK_ROUNDS_MAX)
    if (parsed.value === null) {
      setError(parsed.error)
      setDraft(String(current))
      return
    }
    setError(null)
    if (parsed.value !== current) onCommit(parsed.value)
  }
  return (
    <div className="flex flex-col items-end gap-[var(--space-1)]">
      <div className="flex items-center gap-2">
        <input
          type="number"
          aria-label="Automatic rework rounds"
          data-testid="settings-tasks-rework-rounds"
          min={0}
          max={TASKS_REWORK_ROUNDS_MAX}
          step={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          className="w-[72px] bg-[var(--content-bg)] border border-[var(--border)] rounded-[var(--tr-radius-input)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2 text-right"
        />
        <span className="[font-size:var(--tr-text-label-size)] text-[var(--text-faint)] whitespace-nowrap">
          0–{TASKS_REWORK_ROUNDS_MAX}
        </span>
      </div>
      {error !== null && (
        <div
          data-testid="settings-tasks-rework-rejected"
          className="[font-size:var(--tr-text-small-size)] text-[var(--danger)] max-w-[240px] text-right"
        >
          {error}
        </div>
      )}
    </div>
  )
}

const AGENT_OPTIONS: SelectOption[] = TASK_AGENTS.map((value) => ({
  value,
  label: taskAgentLabel(value)
}))

const DELIVERY_OPTIONS: { value: TaskPromptDelivery; label: string }[] = [
  { value: 'send', label: 'Send' },
  { value: 'prefill', label: 'Prefill only' }
]

const REVIEWER_OPTIONS: SelectOption[] = [
  { value: 'none', label: 'None' },
  ...TASK_AGENTS.map((value) => ({ value, label: taskAgentLabel(value) }))
]
