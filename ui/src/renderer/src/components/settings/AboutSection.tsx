import { BTN_GHOST, BTN_PRIMARY } from '../buttonChrome'
import { Toggle } from '../settingsPrimitives'
import { ThirdPartyNotices } from './ThirdPartyNotices'
import { Group, Row } from './shared'
import type { HostInfo } from '../SettingsView'
import type { UpdatePolicy } from '../../houston/generated/UpdatePolicy'
import type { UpdateState } from '../../houston/generated/UpdateState'
import { summarizeReleaseNotes } from '../../releaseNotes'
import {
  resetUpdateInstall,
  startUpdateInstall,
  useUpdateInstall,
  type UpdateInstallState
} from '../../updateInstall'
import { dismissUpdate, restoreUpdate, useDismissedUpdate } from '../../updateDismissal'

export interface AboutSectionProps {
  onContact: () => void
  onOpenLicense: () => void
  hostInfo: HostInfo | null
  update: { policy: UpdatePolicy; state: UpdateState } | null
  onUpdateCheckNow: () => void
  onUpdatePolicySet: (policy: UpdatePolicy) => void
  onOpenExternal: (url: string) => void
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
    case 'installing':
      return {
        title: `Houston ${version}`,
        desc: 'Downloaded and signature-verified. Installing now.'
      }
    case 'installed':
      return install.version === version
        ? {
            title: `Houston ${install.version} installed`,
            desc: 'Quit and reopen Houston to run the new version.'
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
    <button
      className={`btn ${BTN_GHOST}`}
      data-testid="update-release-notes"
      onClick={() => onOpenExternal(url)}
    >
      Release notes
    </button>
  )
}

function CheckNowButton({ onCheckNow }: { onCheckNow: () => void }): React.JSX.Element {
  return (
    <button className={`btn ${BTN_GHOST}`} data-testid="update-check-now" onClick={onCheckNow}>
      Check now
    </button>
  )
}

function LaterButton({ version, waved }: { version: string; waved: boolean }): React.JSX.Element {
  return (
    <button
      className={`btn ${BTN_GHOST}`}
      data-testid="update-later"
      onClick={() => (waved ? restoreUpdate() : dismissUpdate(version))}
    >
      {waved ? 'Show again' : 'Later'}
    </button>
  )
}

function updateControls(
  state: UpdateState,
  waved: boolean,
  install: UpdateInstallState,
  onCheckNow: () => void,
  onOpenExternal: (url: string) => void
): React.JSX.Element {
  if (state.kind !== 'available') {
    return (
      <button
        className={`btn ${BTN_GHOST}`}
        data-testid={state.kind === 'disabled' ? 'update-check-once' : 'update-check-now'}
        onClick={onCheckNow}
      >
        {state.kind === 'disabled' ? 'Check once' : 'Check now'}
      </button>
    )
  }
  const version = state.release.version
  const notes = <ReleaseNotesButton url={state.release.notes_url} onOpenExternal={onOpenExternal} />
  if (install.kind === 'downloading' || install.kind === 'installing') {
    return (
      <div className="flex items-center gap-[var(--space-2)]">
        {notes}
        <button className={`btn ${BTN_GHOST}`} disabled data-testid="update-install-progress">
          {progressLabel(install)}
        </button>
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
        <button
          className={`btn ${BTN_PRIMARY}`}
          data-testid="update-retry"
          onClick={() => void startUpdateInstall(version)}
        >
          Try again
        </button>
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
      <button
        className={`btn ${BTN_PRIMARY}`}
        data-testid="update-install"
        onClick={() => void startUpdateInstall(version)}
      >
        Install update
      </button>
    </div>
  )
}

function UpdateOfferRow({
  state,
  waved,
  install,
  onCheckNow,
  onOpenExternal
}: {
  state: UpdateState
  waved: boolean
  install: UpdateInstallState
  onCheckNow: () => void
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const copy =
    (state.kind === 'available' ? installCopy(install, state.release.version) : null) ??
    updateCopy(state, waved)
  // Plain text, never rendered as HTML; the full body lives on the release page.
  const summary = state.kind === 'available' ? summarizeReleaseNotes(state.release.notes) : null
  return (
    <>
      <Row title={copy.title} desc={copy.desc}>
        {updateControls(state, waved, install, onCheckNow, onOpenExternal)}
      </Row>
      {summary !== null && (
        <div
          data-testid="update-release-summary"
          className="border-t border-t-[var(--divider)] py-[var(--space-3)] px-[var(--space-4)] [font-size:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-secondary)] whitespace-pre-wrap break-words"
        >
          {summary}
        </div>
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
  onOpenExternal
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
      <div className="mb-[var(--space-5)]">
        <div className="text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.25] text-[var(--text-primary)]">About</div>
      </div>
      <div className="">
        <Row title="Houston" desc={houstonDesc}>
          <span className="text-[var(--text-muted)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] font-mono py-[2px] px-[6px] border border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-[color-mix(in_srgb,var(--content-bg)_60%,transparent)] rounded-sm">v{__APP_VERSION__}</span>
        </Row>
        <Row title="Contact" desc="Open a new issue on GitHub — bug reports, feature requests, questions">
          <button className={`btn ${BTN_GHOST}`} onClick={onContact}>
            Contact
          </button>
        </Row>
        <Row
          title="License"
          desc="Apache-2.0, and the notices for the code Houston vendors (NOTICE)"
        >
          <button className={`btn ${BTN_GHOST}`} onClick={onOpenLicense}>
            View
          </button>
        </Row>
        <ThirdPartyNotices />
      </div>

      <Group heading="Updates">
        <UpdateOfferRow
          state={state}
          waved={waved}
          install={install}
          onCheckNow={checkNow}
          onOpenExternal={onOpenExternal}
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
