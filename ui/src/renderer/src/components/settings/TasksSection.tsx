import { useEffect, useMemo, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { Workspace } from '../../houston/generated/Workspace'
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
import { Text } from '../ui/Text'
import { TextInput } from '../ui/TextInput'
import { TaskAccessSummary, TaskInputError, TaskKeyPrefix, TaskReworkRoundsLayout, TaskReviewRefusal, TaskSettingDescription } from '../ui/TaskSettingDetails'
import { TaskTrackerSettingsSection } from './TaskTrackerSettingsSection'

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

/// The daemon's known workspaces, from a `workspace_list` request.
function useWorkspaceList(client: HoustonClient | null): Workspace[] {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  useEffect(() => {
    if (!client) return
    const off = client.subscribe('workspace_list', (message) => setWorkspaces(message.workspaces))
    client.send({ type: 'workspace_list' })
    return off
  }, [client])
  return workspaces
}

/// The picked workspace, else the one open in the grid, else the first known one.
function usePickedWorkspace(client: HoustonClient | null, activeWorkspace: string | null): {
  workspace: string | null
  workspaceName: string | null
  options: SelectOption[]
  setPicked: (path: string) => void
} {
  const workspaces = useWorkspaceList(client)
  const [picked, setPicked] = useState<string | null>(null)
  const options = useMemo<SelectOption[]>(() => workspaces.map((w) => ({ value: w.path, label: w.name })), [workspaces])
  const known = (path: string | null): path is string => path !== null && workspaces.some((w) => w.path === path)
  const workspace = known(picked) ? picked : known(activeWorkspace) ? activeWorkspace : (workspaces[0]?.path ?? null)
  const workspaceName = workspaces.find((w) => w.path === workspace)?.name ?? null
  return { workspace, workspaceName, options, setPicked }
}

/// Settings ▸ Tasks: agent access, the workspace's Start defaults, and review.
/// Every section edits the workspace chosen in the picker, which starts on the
/// workspace open in the grid and falls back to the first known one.
export function TasksSection({
  client,
  workspace: activeWorkspace
}: {
  client: HoustonClient | null
  workspace: string | null
}): React.JSX.Element {
  const { workspace, workspaceName, options, setPicked } = usePickedWorkspace(client, activeWorkspace)
  const { access, setAccess } = useTasksAccess(client, workspace)
  const { settings, setStartSettings } = useTaskStartSettings(client, workspace)
  const { settings: review, refusal: reviewRefusal, setReviewSettings } = useTaskReviewSettings(client, workspace)
  const noWorkspaceReason = 'Add a workspace to manage its task settings'

  return (
    <>
      <SettingsList>
        <Row title="Workspace" desc="Agent access, Start defaults, review and tracker sync below apply to this workspace.">
          <Select
            aria-label="Workspace"
            data-testid="settings-tasks-workspace"
            value={workspace ?? ''}
            options={options}
            disabled={options.length === 0}
            width="task-setting"
            onChange={setPicked}
          />
        </Row>
      </SettingsList>
      <SubHead>Agent access</SubHead>
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
        <Row title="Default agent" desc={<><span>Used by Start. Pick another one from the Start menu.</span><SettingsScope workspace={workspaceName} /></>}>
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
          desc={<><span>Send the brief when you press Start, or only place it in the input box.</span><SettingsScope workspace={workspaceName} /></>}
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
          desc={<><span>Runs read-only in the same worktree when a task is handed back. Reports evidence; it does not mark a task done.</span><SettingsScope workspace={workspaceName} /></>}
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
          desc={<><span>How many times a failed review restarts the implementer on its own. 0 asks you first.</span><SettingsScope workspace={workspaceName} /></>}
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
      <TaskTrackerSettingsSection client={client} workspace={workspace} workspaceName={workspaceName} />
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
          <TaskSettingDescription>
            Agents can read the global backlog and write tasks assigned to this workspace or no
            workspace. Tasks of another workspace are read-only to agents. Children of an
            orchestrator never see the backlog; they get their brief.
            <TaskAccessSummary testId="settings-tasks-current">
              {access === null ? 'loading…' : ACCESS_LABEL[access]}
            </TaskAccessSummary>
            <SettingsScope workspace={workspace} />
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
