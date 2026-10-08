import { Button, Chip, ChangeSummary, VersionBadge } from '../ui'
import { SettingsList, Toggle } from '../ui/settingsPrimitives'
import { ThirdPartyNotices } from './ThirdPartyNotices'
import { Group, Row } from './shared'
import type { HostInfo } from '../SettingsView'
import type { UpdatePolicy } from '../../houston/generated/UpdatePolicy'
import type { UpdateState } from '../../houston/generated/UpdateState'
import { summarizeReleaseNotes } from '../../releaseNotes'
import {
  isUpdateInstallRunning,
  resetUpdateInstall,
  useUpdateInstall,
  type UpdateInstallState
} from '../../updateInstall'
import { openUpdateModal } from '../../updateModal'
import { dismissUpdate, restoreUpdate, useDismissedUpdate } from '../../updateDismissal'

export interface AboutSectionProps {
  onContact: () => void
  onOpenLicense: () => void
  hostInfo: HostInfo | null
  update: { policy: UpdatePolicy; state: UpdateState } | null
  onUpdateCheckNow: () => void
  onUpdatePolicySet: (policy: UpdatePolicy) => void
  onOpenExternal: (url: string) => void
  /** Live sessions the daemon owns, so the Install row says what an update touches. */
  liveSessionCount?: number
}

// No Intl: the test must not depend on the machine's locale.
function relativeTime(deltaMs: number): string {
  const secs = Math.max(0, Math.round(deltaMs / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function updateCopy(state: UpdateState, waved: boolean): { title: string; desc: string } {
  switch (state.kind) {
    case 'disabled':
      return {
        title: 'Not checking',
        desc: 'Houston has not asked whether a release exists. Nothing is sent when it does.'
      }
    case 'checking':
      return { title: 'Checking', desc: 'Asking whether a newer release exists.' }
    case 'up_to_date':
      return {
        title: 'Newest release',
        desc: `You are on the newest release. Checked ${relativeTime(Date.now() - state.checked_at_ms)}.`
      }
    case 'available':
      return {
        title: `Houston ${state.release.version}`,
        desc: waved
          ? 'A newer release is out. Waved off, so the sidebar stays quiet until a later one appears.'
          : "A newer release is out. Installing it is your click, not Houston's."
      }
    case 'failed':
      return { title: 'Could not check', desc: state.error }
    default:
      return { title: 'Updates', desc: 'Houston has not looked yet.' }
  }
}

function downloadPercent(install: UpdateInstallState): number | null {
  if (install.kind !== 'downloading') return null
  if (install.total === null || install.total <= 0) return null
  return Math.min(100, Math.floor((install.downloaded / install.total) * 100))
}

function progressLabel(install: UpdateInstallState): string {
  if (install.kind === 'verifying') return 'Verifying…'
  if (install.kind === 'stopping') return 'Stopping sessions…'
  if (install.kind === 'installing') return 'Installing…'
  const pct = downloadPercent(install)
  return pct === null ? 'Downloading…' : `Downloading… ${pct}%`
}

// What the install flight, not the daemon, has to say while it runs. A refusal
// here is the backend's own sentence, shown verbatim.
function installCopy(
  install: UpdateInstallState,
  version: string
): { title: string; desc: string } | null {
  switch (install.kind) {
    case 'downloading': {
      const pct = downloadPercent(install)
      return {
        title: `Houston ${version}`,
        desc: `Downloading the installer${pct === null ? '' : ` — ${pct}%`}. Its signature is verified against Houston's signing key before anything is installed.`
      }
    }
    case 'verifying':
      return {
        title: `Houston ${version}`,
        desc: "Downloaded. Checking the signature against Houston's signing key before anything is installed."
      }
    case 'stopping':
      return {
        title: `Houston ${version}`,
        desc: 'Signature verified. Stopping the sessions you confirmed, then installing.'
      }
    case 'installing':
      return {
        title: `Houston ${version}`,
        desc: 'Downloaded and signature-verified. Installing now; Houston will reopen automatically.'
      }
    case 'installed':
      return install.version === version
        ? {
            title: `Houston ${install.version} installed`,
            desc: 'Houston is reopening with the new version.'
          }
        : null
    case 'failed':
      return install.version === version
        ? { title: `Could not install Houston ${install.version}`, desc: install.error }
        : null
    case 'up_to_date':
      return {
        title: `Houston ${version}`,
        desc: 'The signed update feed offers nothing newer than the Houston you are running, so nothing was installed.'
      }
    default:
      return null
  }
}

function ReleaseNotesButton({
  url,
  onOpenExternal
}: {
  url: string
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  return (
    <Button
      variant="legacy-ghost"
      data-testid="update-release-notes"
      onClick={() => onOpenExternal(url)}
    >
      Release notes
    </Button>
  )
}

function CheckNowButton({ onCheckNow }: { onCheckNow: () => void }): React.JSX.Element {
  return (
    <Button variant="legacy-ghost" data-testid="update-check-now" onClick={onCheckNow}>
      Check now
    </Button>
  )
}

function LaterButton({ version, waved }: { version: string; waved: boolean }): React.JSX.Element {
  return (
    <Button
      variant="legacy-ghost"
      data-testid="update-later"
      onClick={() => (waved ? restoreUpdate() : dismissUpdate(version))}
    >
      {waved ? 'Show again' : 'Later'}
    </Button>
  )
}

function updateControls(
  state: UpdateState,
  waved: boolean,
  install: UpdateInstallState,
  onCheckNow: () => void,
  onOpenExternal: (url: string) => void,
  liveSessionCount: number | undefined
): React.JSX.Element {
  if (state.kind !== 'available') {
    return (
      <Button
        variant="legacy-ghost"
        data-testid={state.kind === 'disabled' ? 'update-check-once' : 'update-check-now'}
        onClick={onCheckNow}
      >
        {state.kind === 'disabled' ? 'Check once' : 'Check now'}
      </Button>
    )
  }
  const version = state.release.version
  const notes = <ReleaseNotesButton url={state.release.notes_url} onOpenExternal={onOpenExternal} />
  if (isUpdateInstallRunning(install)) {
    return (
      <div className="flex items-center gap-[var(--space-2)]">
        {notes}
        <Button
          variant="legacy-ghost"
          data-testid="update-install-progress"
          onClick={openUpdateModal}
        >
          {progressLabel(install)}
        </Button>
      </div>
    )
  }
  if (install.kind === 'installed' && install.version === version) {
    return (
      <div className="flex items-center gap-[var(--space-2)]">
        {notes}
        <CheckNowButton onCheckNow={onCheckNow} />
      </div>
    )
  }
  if (install.kind === 'failed' && install.version === version) {
    return (
      <div className="flex items-center gap-[var(--space-2)]">
        {notes}
        <Button
          variant="legacy-primary"
          data-testid="update-retry"
          onClick={openUpdateModal}
        >
          Try again
        </Button>
        <LaterButton version={version} waved={waved} />
      </div>
    )
  }
  if (install.kind === 'up_to_date') {
    return (
      <div className="flex items-center gap-[var(--space-2)]">
        {notes}
        <CheckNowButton onCheckNow={onCheckNow} />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-[var(--space-2)]">
      {notes}
      <CheckNowButton onCheckNow={onCheckNow} />
      <LaterButton version={version} waved={waved} />
      {liveSessionCount !== undefined && (
        <span data-testid="update-live-sessions">
          <Chip
            variant="state"
            tone={liveSessionCount > 0 ? 'info' : 'default'}
            label={
              liveSessionCount === 0
                ? 'No live sessions'
                : `${liveSessionCount} live session${liveSessionCount === 1 ? '' : 's'}`
            }
          />
        </span>
      )}
      <Button
        variant="legacy-primary"
        data-testid="update-install"
        onClick={openUpdateModal}
      >
        Install update…
      </Button>
    </div>
  )
}

function UpdateOfferRow({
  state,
  waved,
  install,
  onCheckNow,
  onOpenExternal,
  liveSessionCount
}: {
  state: UpdateState
  waved: boolean
  install: UpdateInstallState
  onCheckNow: () => void
  onOpenExternal: (url: string) => void
  liveSessionCount: number | undefined
}): React.JSX.Element {
  const copy =
    (state.kind === 'available' ? installCopy(install, state.release.version) : null) ??
    updateCopy(state, waved)
  // Plain text, never rendered as HTML; the full body lives on the release page.
  const summary = state.kind === 'available' ? summarizeReleaseNotes(state.release.notes) : null
  return (
    <>
      <Row title={copy.title} desc={copy.desc}>
        {updateControls(state, waved, install, onCheckNow, onOpenExternal, liveSessionCount)}
      </Row>
      {summary !== null && (
        <ChangeSummary data-testid="update-release-summary">
          {summary}
        </ChangeSummary>
      )}
    </>
  )
}

export function AboutSection({
  onContact,
  onOpenLicense,
  hostInfo,
  update,
  onUpdateCheckNow,
  onUpdatePolicySet,
  onOpenExternal,
  liveSessionCount
}: AboutSectionProps): React.JSX.Element {
  const dismissed = useDismissedUpdate()
  const install = useUpdateInstall()
  const state: UpdateState = update?.state ?? { kind: 'unknown' }
  const policy: UpdatePolicy = update?.policy ?? { check: true }
  const waved = state.kind === 'available' && dismissed === state.release.version
  const houstonDesc = hostInfo
    ? `Local-first mission control for CLI coding agents · channel ${hostInfo.channel} · commit ${hostInfo.build_commit}`
    : 'Local-first mission control for CLI coding agents'
  // A fresh check is also the way out of a stale refusal or an install notice.
  const checkNow = (): void => {
    resetUpdateInstall()
    onUpdateCheckNow()
  }

  return (
    <>
      <SettingsList>
        <Row title="Houston" desc={houstonDesc}>
          <VersionBadge>v{__APP_VERSION__}</VersionBadge>
        </Row>
        <Row title="Contact" desc="Open a new issue on GitHub — bug reports, feature requests, questions">
          <Button variant="legacy-ghost" onClick={onContact}>
            Contact
          </Button>
        </Row>
        <Row
          title="License"
          desc="Apache-2.0, and the notices for the code Houston vendors (NOTICE)"
        >
          <Button variant="legacy-ghost" onClick={onOpenLicense}>
            View
          </Button>
        </Row>
        <ThirdPartyNotices />
      </SettingsList>

      <Group heading="Updates">
        <UpdateOfferRow
          state={state}
          waved={waved}
          install={install}
          onCheckNow={checkNow}
          onOpenExternal={onOpenExternal}
          liveSessionCount={liveSessionCount}
        />
        <Row
          title="Check for updates"
          desc="Checks for new releases at startup and every 6 hours. You can also use Check now."
        >
          <Toggle
            on={policy.check}
            data-testid="update-policy-toggle"
            onChange={(check) => onUpdatePolicySet({ ...policy, check })}
          />
        </Row>
      </Group>
    </>
  )
}
