import {
  RESTORE_BUDGET_MAX,
  WORKTREE_CLEANUP_GRACE_HOURS_MAX,
  WORKTREE_IDLE_REMOVAL_DAYS_MAX,
  WORKTREE_IDLE_REMOVAL_DAYS_MIN
} from '../../houston/generated/DEFAULTS'
import { Caption } from '../ui/Caption'
import { SettingsList, Toggle } from '../ui/settingsPrimitives'
import type { HostInfo } from '../SettingsView'
import type { SessionPolicy } from '../../houston/generated/SessionPolicy'
import { SettingsScope } from '../ui/SettingsScope'
import { Text } from '../ui/Text'
import { TextInput } from '../ui/TextInput'
import { NumberSetting, Row, SubHead } from './shared'


function globalDescription(description: string): React.JSX.Element {
  return <><SettingsScope workspace={null} row scope="global" />{description}</>
}

export interface WorkspaceDefaultsSectionProps {
  onRestoreBudgetSet: (n: number) => void
  onRestoreResumeSet: (on: boolean) => void
  onWorktreeCleanupSet: (enabled: boolean, graceHours: number) => void
  onWorktreeIdleRemovalDaysSet: (days: number) => void
  openLinksInPane: boolean
  onOpenLinksInPane: (on: boolean) => void
  hostInfo: HostInfo | null
  sessionPolicy: SessionPolicy | null
  onSessionPolicy: (next: SessionPolicy) => void
}

export function WorkspaceDefaultsSection({
  onRestoreBudgetSet,
  onRestoreResumeSet,
  onWorktreeCleanupSet,
  onWorktreeIdleRemovalDaysSet,
  openLinksInPane,
  onOpenLinksInPane,
  hostInfo,
  sessionPolicy,
  onSessionPolicy
}: WorkspaceDefaultsSectionProps): React.JSX.Element {
  return (
    <>
      <SubHead>Restoring</SubHead>
      <SettingsList>
        <Row
          title="Restore budget"
          desc={globalDescription(`How many sessions boot at once. The rest come back deferred. Up to ${RESTORE_BUDGET_MAX}.`)}
        >
          {!hostInfo ? (
            <Text size="small" weight="small" tone="muted">Asking the daemon…</Text>
          ) : (
            <NumberSetting
              value={hostInfo.restore_budget}
              max={RESTORE_BUDGET_MAX}
              unit="sessions"
              testId="settings-restore-budget"
              onCommit={onRestoreBudgetSet}
            />
          )}
        </Row>
        <Row
          title="Resume conversations when restoring panes"
          desc={globalDescription('After an orderly shutdown, each restored Claude pane reopens the conversation it was running. Nothing is sent to the model until you type. Off: restored panes start a fresh CLI.')}
        >
          <Toggle
            on={hostInfo?.restore_resume ?? true}
            disabled={hostInfo === null}
            onChange={onRestoreResumeSet}
            data-testid="restore-resume-switch"
          />
        </Row>
      </SettingsList>
      <SubHead>Worktrees</SubHead>
      <SettingsList>
        <Row
          title="Remove worktrees automatically"
          desc={globalDescription('Every 6 h, remove clean worktrees after their PR is merged or their commits are integrated into the branch they came from, after the grace period; their branches are removed. Remove idle worktrees after the configured threshold, keeping their branches. Worktrees with uncommitted changes, unpushed commits or a pane inside stay. Off by default, because it deletes files.')}
        >
          <Toggle
            on={hostInfo?.worktree_cleanup_enabled ?? false}
            disabled={hostInfo === null}
            onChange={(on) =>
              hostInfo && onWorktreeCleanupSet(on, hostInfo.worktree_cleanup_grace_hours)
            }
            data-testid="worktree-cleanup-switch"
          />
        </Row>
        <Row
          title="Grace after merge"
          desc={globalDescription(`How long a merged worktree is kept before it can be removed. 1 to ${WORKTREE_CLEANUP_GRACE_HOURS_MAX} h.`)}
        >
          {!hostInfo ? (
            <Text size="small" weight="small" tone="muted">Asking the daemon…</Text>
          ) : (
            <NumberSetting
              value={hostInfo.worktree_cleanup_grace_hours}
              max={WORKTREE_CLEANUP_GRACE_HOURS_MAX}
              min={1}
              unit="hours"
              testId="settings-worktree-cleanup-grace"
              onCommit={(hours) => onWorktreeCleanupSet(hostInfo.worktree_cleanup_enabled, hours)}
            />
          )}
        </Row>
        <Row
          title="Remove idle worktrees after"
          desc={globalDescription(`A clean worktree with every commit on a remote and no pane inside is removed once nobody has touched it for this long; its branch is kept. It shows as Stale from halfway there. Needs automatic removal on. 1 to ${WORKTREE_IDLE_REMOVAL_DAYS_MAX} days.`)}
        >
          {!hostInfo ? (
            <Caption>Asking the daemon…</Caption>
          ) : (
            <NumberSetting
              value={hostInfo.worktree_idle_removal_days}
              min={WORKTREE_IDLE_REMOVAL_DAYS_MIN}
              max={WORKTREE_IDLE_REMOVAL_DAYS_MAX}
              unit="days"
              testId="settings-worktree-idle-removal-days"
              onCommit={onWorktreeIdleRemovalDaysSet}
            />
          )}
        </Row>
      </SettingsList>
      <SubHead>Background sessions</SubHead>
      <SettingsList>
        <Row
          title="Close idle background sessions"
          desc={globalDescription('End sessions that have been idle in a hidden workspace. Closing one ends its process; nothing about it is kept. Off by default, because it ends a process you started.')}
        >
          <Toggle
            on={sessionPolicy?.idle_reap_enabled ?? false}
            disabled={sessionPolicy === null}
            onChange={(on) =>
              sessionPolicy && onSessionPolicy({ ...sessionPolicy, idle_reap_enabled: on })
            }
            data-testid="idle-reap-switch"
          />
        </Row>
        <Row
          title="Idle for"
          desc={globalDescription('Minutes of no activity, counted only while the workspace is hidden.')}
        >
          <TextInput
            variant="setting-number-rounded"
            type="number"
            aria-label="Minutes idle before a background session is closed"
            min={1}
            step={5}
            disabled={sessionPolicy === null || !sessionPolicy.idle_reap_enabled}
            value={sessionPolicy?.idle_reap_minutes ?? 15}
            onChange={(e) => {
              if (!sessionPolicy) return
              const n = Math.max(1, Math.trunc(Number(e.target.value)) || 1)
              onSessionPolicy({ ...sessionPolicy, idle_reap_minutes: n })
            }}
          />
        </Row>
      </SettingsList>
      <SubHead>Browser</SubHead>
      <SettingsList>
        <Row
          title="Open links in a browser pane"
          desc={globalDescription('Links printed in panes open inside Houston instead of your system browser.')}
        >
          <Toggle
            on={openLinksInPane}
            onChange={onOpenLinksInPane}
          />
        </Row>
      </SettingsList>
    </>
  )
}
