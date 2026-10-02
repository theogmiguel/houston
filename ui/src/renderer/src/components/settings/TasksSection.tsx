import type { HoustonClient } from '../../houston/client'
import type { TasksAccess } from '../../houston/generated/TasksAccess'
import { useTasksAccess } from '../../houston/useTasks'
import { Segmented } from '../Segmented'
import { SettingsList } from '../settingsPrimitives'
import { SectionHead, Row, SubHead } from './shared'

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

/// Settings ▸ Tasks. Slice 1 carries the access switch only: it gates agents
/// and the control wire alike, so it is the one value this page must show.
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
  const noWorkspaceReason = 'Select a single workspace in the sidebar to manage its tasks'

  return (
    <>
      <SectionHead
        title="Tasks"
        lede="A local backlog per workspace. Tasks never leave this machine; their text reaches a hosted agent CLI only when an agent you allowed reads it or you start a task."
      />
      <SubHead>Agent access · {workspaceName ?? 'no workspace selected'}</SubHead>
      <SettingsList>
        <Row
          title="Agent access"
          desc={
            <span className="block">
              Whether agents running in this workspace can read and write its tasks. Children of an
              orchestrator never see the backlog; they get their brief.
              <span
                data-testid="settings-tasks-current"
                className="block pt-[6px] text-[11.5px] text-[var(--text-muted)]"
              >
                Currently{' '}
                <b className="font-semibold text-[var(--text-primary)]">
                  {access === null ? 'loading…' : ACCESS_LABEL[access]}
                </b>
              </span>
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
            onChange={(value) => setAccess(value as TasksAccess)}
          />
        </Row>
        <Row
          title="Task key prefix"
          desc={
            <span className="block">
              Used in HOU-42. Changing it renames keys in the interface only; history keeps the
              number.
            </span>
          }
        >
          <span className="inline-flex items-center h-[var(--h-ctl)] px-[var(--space-2)] border border-[var(--border)] rounded-[var(--tr-radius-button)] bg-[var(--content-bg)] font-mono text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)]">
            HOU
          </span>
        </Row>
      </SettingsList>
    </>
  )
}
