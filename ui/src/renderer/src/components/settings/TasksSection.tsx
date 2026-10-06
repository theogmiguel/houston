import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { TaskPromptDelivery } from '../../houston/generated/TaskPromptDelivery'
import type { TasksAccess } from '../../houston/generated/TasksAccess'
import { TASKS_REWORK_ROUNDS_MAX } from '../../houston/generated/DEFAULTS'
import type { TaskGithubSettings } from '../../houston/generated/TaskGithubSettings'
import { useTaskGithub, useTaskReviewSettings, useTaskStartSettings, useTasksAccess, type TaskGithubState } from '../../houston/useTasks'
import { IconAgent } from '../icons'
import { Segmented } from '../ui/SegmentedControl'
import { Select, type SelectOption } from '../ui/Select'
import { SettingsList, Toggle } from '../ui/settingsPrimitives'
import { SettingsScope } from '../ui/SettingsScope'
import { Notice } from '../ui'
import { formatAgo, parseReworkRounds, TASK_AGENTS, taskAgentLabel } from '../tasks/format'
import { Row, SubHead } from './shared'
import { Text } from '../ui/Text'
import { TextInput } from '../ui/TextInput'
import { TaskAccessSummary, TaskInputError, TaskKeyPrefix, TaskReworkRoundsLayout, TaskReviewRefusal, TaskSettingDescription } from '../ui/TaskSettingDetails'

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

/// Settings ▸ Tasks: agent access, the workspace's Start defaults, review and
/// the GitHub Issues connector.
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
  const { state: github, refusal: githubRefusal, setGithub } = useTaskGithub(client, workspace)
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
            <TaskSettingDescription>
              The fixed HOU prefix and globally unique number identify a task across workspaces.
            </TaskSettingDescription>
          }
        >
          <TaskKeyPrefix />
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
          width="task-setting"
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
            width="task-setting"
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
        <TaskReviewRefusal testId="settings-tasks-review-refusal">
          {reviewRefusal.message}
        </TaskReviewRefusal>
      )}
      <SubHead>GitHub Issues</SubHead>
      <SettingsList>
        <GithubRows state={github} workspace={workspace} workspaceName={workspaceName} onChange={setGithub} />
      </SettingsList>
      {githubRefusal !== null && <SectionRefusal testId="settings-tasks-github-refusal" message={githubRefusal.message} />}
    </>
  )
}

/// A daemon refusal under its settings group: it names the limit, the value
/// and the operation.
function SectionRefusal({ testId, message }: { testId: string; message: string }): React.JSX.Element {
  return (
    <div data-testid={testId} className="pt-[var(--space-2)] [font-size:var(--tr-text-small-size)] text-[var(--danger)]">
      {message}
    </div>
  )
}

/// The "Currently <value>" line every stateful row shows beside its control.
function CurrentValue({ testId, value }: { testId: string; value: string }): React.JSX.Element {
  return (
    <span data-testid={testId} className="block pt-[6px] text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">
      Currently <b className="font-semibold text-[var(--text-primary)]">{value}</b>
    </span>
  )
}

/// The connector's three settings, each with its current value beside it; the
/// state line names the repository, the last sync and its error.
function GithubRows({
  state,
  workspace,
  workspaceName,
  onChange
}: {
  state: TaskGithubState | null
  workspace: string | null
  workspaceName: string | null
  onChange: (settings: TaskGithubSettings) => void
}): React.JSX.Element {
  const settings = state?.settings ?? { enabled: false, label: null, open_on_create: false }
  const disabled = workspace === null || state === null
  const status = state === null
    ? 'loading…'
    : !settings.enabled
      ? 'Off'
      : `On · ${state.repository ?? 'no github.com remote'}${state.lastSyncAtMs != null ? ` · synced ${formatAgo(state.lastSyncAtMs, Date.now())}` : ''}`
  return (
    <>
      <Row
        title="Import issues"
        desc={
          <>
            <span>
              Open issues with the label below, or assigned to your gh user, become backlog tasks
              linked to their issue. Houston reads and writes GitHub through your gh login.
            </span>
            <CurrentValue testId="settings-tasks-github-current" value={status} />
            {state?.error != null && <Notice tone="danger" data-testid="settings-tasks-github-error">{state.error}</Notice>}
            <SettingsScope workspace={workspaceName} row />
          </>
        }
      >
        <Toggle
          aria-label="Import GitHub issues"
          data-testid="settings-tasks-github-enabled"
          on={settings.enabled}
          disabled={disabled}
          onChange={(enabled) => onChange({ ...settings, enabled })}
        />
      </Row>
      <Row
        title="Label"
        desc={<><span>Issues carrying this label are imported. Empty imports only your assigned issues.</span><SettingsScope workspace={workspaceName} row /></>}
      >
        <GithubLabelInput
          value={settings.label ?? ''}
          disabled={disabled}
          onCommit={(label) => onChange({ ...settings, label: label === '' ? null : label })}
        />
      </Row>
      <Row
        title="Open an issue for every new task"
        desc={<><span>A task you create in this workspace opens an issue with its title, description and acceptance. Otherwise use Open GitHub issue on a task.</span><SettingsScope workspace={workspaceName} row /></>}
      >
        <Toggle
          aria-label="Open an issue for every new task"
          data-testid="settings-tasks-github-open-on-create"
          on={settings.open_on_create}
          disabled={disabled || !settings.enabled}
          onChange={(open) => onChange({ ...settings, open_on_create: open })}
        />
      </Row>
    </>
  )
}

/// The label field commits on blur or Enter; the daemon refuses an over-long
/// label naming GitHub's limit, and the refusal shows below the section.
function GithubLabelInput({
  value,
  disabled,
  onCommit
}: {
  value: string
  disabled: boolean
  onCommit: (label: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <TextInput
      type="text"
      width="md"
      aria-label="GitHub label"
      data-testid="settings-tasks-github-label"
      placeholder="houston"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onCommit(draft.trim())
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
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
          <TaskSettingDescription>
            Agents can read the global backlog and write tasks assigned to this workspace or no
            workspace. Tasks of another workspace are read-only to agents. Children of an
            orchestrator never see the backlog; they get their brief.
            <TaskAccessSummary testId="settings-tasks-current">
              {access === null ? 'loading…' : ACCESS_LABEL[access]}
            </TaskAccessSummary>
            <SettingsScope workspace={workspace} row />
          </TaskSettingDescription>
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
    <TaskReworkRoundsLayout>
      <div className="flex items-center gap-[var(--space-2)]">
        <TextInput
          variant="task-number"
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
        />
        <Text size="caption" tone="faint">
          0–{TASKS_REWORK_ROUNDS_MAX}
        </Text>
      </div>
      {error !== null && (
        <div data-testid="settings-tasks-rework-rejected"><TaskInputError>{error}</TaskInputError></div>
      )}
    </TaskReworkRoundsLayout>
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
