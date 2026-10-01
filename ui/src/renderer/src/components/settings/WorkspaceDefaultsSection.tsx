import { RESTORE_BUDGET_MAX, WORKTREE_CLEANUP_GRACE_HOURS_MAX } from '../../houston/generated/DEFAULTS'
import { SettingsList, Toggle } from '../settingsPrimitives'
import type { HostInfo } from '../SettingsView'
import type { SessionPolicy } from '../../houston/generated/SessionPolicy'
import { NumberSetting, Row, SectionHead, SubHead } from './shared'

export interface WorkspaceDefaultsSectionProps {
  onRestoreBudgetSet: (n: number) => void
  onRestoreResumeSet: (on: boolean) => void
  onWorktreeCleanupSet: (enabled: boolean, graceHours: number) => void
  openLinksInPane: boolean
  onOpenLinksInPane: (on: boolean) => void
  historyWorkspace: string | null
  historyWorkspaceName: string | null
  hostInfo: HostInfo | null
  sessionPolicy: SessionPolicy | null
  onSessionPolicy: (next: SessionPolicy) => void
}

export function WorkspaceDefaultsSection({
  onRestoreBudgetSet,
  onRestoreResumeSet,
  onWorktreeCleanupSet,
  openLinksInPane,
  onOpenLinksInPane,
  historyWorkspace,
  historyWorkspaceName,
  hostInfo,
  sessionPolicy,
  onSessionPolicy
}: WorkspaceDefaultsSectionProps): React.JSX.Element {
  return (
    <>
      <SectionHead
        title="Workspaces"
        lede="What happens to sessions in a workspace nobody is watching, and the one live setting the workspace you have selected can differ on."
      />
      <SubHead>Restoring</SubHead>
      <SettingsList>
        <Row
          title="Restore budget"
          desc={`How many sessions boot at once. The rest come back deferred. Up to ${RESTORE_BUDGET_MAX}.`}
        >
          {!hostInfo ? (
            <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">Asking the daemon…</span>
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
          desc="After an orderly shutdown, each restored Claude pane reopens the conversation it was running. Nothing is sent to the model until you type. Off: restored panes start a fresh CLI."
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
          title="Remove merged worktrees automatically"
          desc="Every 6 h, remove a worktree Houston created once its PR has merged, with its branch. A worktree with uncommitted changes, commits outside the PR or a pane inside it stays. Off by default, because it deletes files."
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
          desc={`How long a merged worktree is kept before it can be removed. 1 to ${WORKTREE_CLEANUP_GRACE_HOURS_MAX} h.`}
        >
          {!hostInfo ? (
            <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">Asking the daemon…</span>
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
      </SettingsList>
      <SubHead>Background sessions</SubHead>
      <SettingsList>
        <Row
          title="Close idle background sessions"
          desc="End sessions that have been idle in a hidden workspace. Closing one ends its process; nothing about it is kept. Off by default, because it ends a process you started."
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
          desc="Minutes of no activity, counted only while the workspace is hidden."
        >
          <input
            type="number"
            aria-label="Minutes idle before a background session is closed"
            className="w-[64px] bg-[var(--content-bg)] border border-[var(--border)] rounded-[var(--tr-radius-sm)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2 text-right disabled:opacity-50"
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
      <SubHead>This workspace</SubHead>
      <SettingsList>
        <Row
          title="Open links in a browser pane"
          desc={
            historyWorkspace === null
              ? 'Select a single workspace in the sidebar to change where its links open'
              : `Links in ${historyWorkspaceName ?? historyWorkspace} open inside Houston, not your system browser.`
          }
        >
          <Toggle
            on={openLinksInPane}
            onChange={onOpenLinksInPane}
            disabled={historyWorkspace === null}
          />
        </Row>
      </SettingsList>
    </>
  )
}
