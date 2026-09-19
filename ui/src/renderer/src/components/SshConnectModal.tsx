import { useEffect, useRef, useState } from 'react'
import { Toggle } from './settingsPrimitives'
import type { SshAuth, SshProfile, SshConfigHost } from '../houston/client'
import { pickFile } from '../houston/bridge'
import { IconClose, IconCopy, IconPencil } from './icons'
import { BTN_GHOST, BTN_PRIMARY } from './buttonChrome'
import { Tooltip } from './Tooltip'
import { Icon } from './Icon'
import { MODAL_SCRIM_CLS } from './overlayChrome'
import { useFocusTrap } from './dialogFocus'
import { useSshProfileEditor } from './useSshProfileEditor'

export interface SshConnectParams {
  host: string
  port?: number
  user: string
  auth: SshAuth
  profile?: string
}

export interface SshInitial {
  host: string
  port?: number
  user: string
}

interface Props {
  profiles: SshProfile[]
  initial?: SshInitial | null
  onConnect: (params: SshConnectParams) => void
  onSaveProfile: (profile: SshProfile) => void
  onSetCredential?: (profile: string, password: string) => void
  onClearCredential?: (profile: string) => void
  configHosts?: SshConfigHost[]
  keyringError?: string | null
  onLoadConfigHosts?: () => void
  onDeleteProfile: (name: string) => void
  onClose: () => void
}

const DEFAULT_PORT = 22

export interface SshFormState {
  canConnect: boolean
  canSaveProfile: boolean
  hostError: string | null
  userError: string | null
  identityError: string | null
  credentialProfileName: string
  credentialStored: boolean
}

export function computeSshFormState(input: {
  host: string
  user: string
  authKind: SshAuth['kind']
  identityPath: string
  touched: { host: boolean; user: boolean; identity: boolean }
  editingProfileName: string | null
  appliedProfile: string | null
  saveAsProfile: boolean
  profileName: string
  profiles: SshProfile[]
}): SshFormState {
  const identityMissing = input.authKind === 'identity_file' && input.identityPath.trim() === ''
  const canConnect = input.host.trim() !== '' && input.user.trim() !== '' && !identityMissing
  const hasProfileName =
    input.editingProfileName !== null || (input.saveAsProfile && input.profileName.trim() !== '')
  const canSaveProfile = canConnect && hasProfileName

  const hostError = input.touched.host && input.host.trim() === '' ? 'Host is required' : null
  const userError = input.touched.user && input.user.trim() === '' ? 'Username is required' : null
  const identityError =
    input.touched.identity && identityMissing
      ? 'An identity file is required for this auth method'
      : null

  const credentialProfileName =
    input.editingProfileName ?? input.appliedProfile ?? input.profileName.trim()
  const credentialStored =
    input.profiles.find((p) => p.name === credentialProfileName)?.has_credential ?? false

  return {
    canConnect,
    canSaveProfile,
    hostError,
    userError,
    identityError,
    credentialProfileName,
    credentialStored
  }
}

export function SshConnectModal({
  profiles,
  initial,
  onConnect,
  onSaveProfile,
  onSetCredential,
  onClearCredential,
  configHosts,
  keyringError,
  onLoadConfigHosts,
  onDeleteProfile,
  onClose
}: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const hostInputRef = useRef<HTMLInputElement>(null)
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? DEFAULT_PORT))
  const [user, setUser] = useState(initial?.user ?? '')
  const [authKind, setAuthKind] = useState<SshAuth['kind']>('agent')
  const [identityPath, setIdentityPath] = useState('')
  const [saveAsProfile, setSaveAsProfile] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [password, setPassword] = useState('')
  const [defaultDir, setDefaultDir] = useState('')
  const [startupCmd, setStartupCmd] = useState('')

  const [touched, setTouched] = useState({ host: false, user: false, identity: false })
  const markTouched = (field: keyof typeof touched) => (): void =>
    setTouched((t) => ({ ...t, [field]: true }))

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input')?.focus()
  }, [])

  const {
    editingProfileName,
    setEditingProfileName,
    appliedProfile,
    setAppliedProfile,
    applyProfile,
    duplicateProfile,
    startEdit,
    cancelEdit
  } = useSshProfileEditor(profiles, {
    host,
    setHost,
    port,
    setPort,
    user,
    setUser,
    authKind,
    setAuthKind,
    identityPath,
    setIdentityPath,
    setPassword,
    setDefaultDir,
    setStartupCmd,
    setProfileName,
    setSaveAsProfile,
    resetTouched: () => setTouched({ host: false, user: false, identity: false }),
    hostInputRef
  })

  useEffect(() => {
    onLoadConfigHosts?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const importConfigHost = (h: SshConfigHost): void => {
    setHost(h.alias)
    setUser(h.user ?? '')
    setPort(String(h.port ?? DEFAULT_PORT))
    setAuthKind('ssh_config')
    setIdentityPath(h.identity_file ?? '')
    setEditingProfileName(null)
    setAppliedProfile(null)
    setProfileName(h.alias)
    setSaveAsProfile(true)
    hostInputRef.current?.focus()
  }

  const connectProfile = (p: SshProfile): void => {
    onConnect({ host: p.host, port: p.port, user: p.user, auth: p.auth, profile: p.name })
    onClose()
  }

  const recent = profiles
    .filter((p) => p.last_used_at != null)
    .sort((a, b) => (b.last_used_at ?? 0) - (a.last_used_at ?? 0))
    .slice(0, 4)

  const edited = <T,>(set: (v: T) => void) => (v: T): void => {
    set(v)
    setAppliedProfile(null)
  }

  const choosePath = async (): Promise<void> => {
    const picked = await pickFile('')
    if (picked) edited(setIdentityPath)(picked)
  }

  const {
    canConnect,
    canSaveProfile,
    hostError,
    userError,
    identityError,
    credentialProfileName,
    credentialStored
  } = computeSshFormState({
    host,
    user,
    authKind,
    identityPath,
    touched,
    editingProfileName,
    appliedProfile,
    saveAsProfile,
    profileName,
    profiles
  })

  const buildAuth = (): SshAuth => {
    switch (authKind) {
      case 'identity_file':
        return {
          kind: 'identity_file',
          path: identityPath.trim(),
          passphrase_profile: credentialStored ? credentialProfileName : null
        }
      case 'password':
        return { kind: 'password', profile: credentialProfileName }
      case 'ssh_config':
        return { kind: 'ssh_config' }
      default:
        return { kind: 'agent' }
    }
  }

  const persistCredential = (name: string): void => {
    if (!name || password === '') return
    onSetCredential?.(name, password)
    setPassword('')
  }

  const buildProfile = (name: string): SshProfile => {
    const portNum = Number(port)
    const validPort = Number.isFinite(portNum) && portNum > 0 ? portNum : undefined
    return {
      name,
      host: host.trim(),
      port: validPort ?? DEFAULT_PORT,
      user: user.trim(),
      auth: buildAuth(),
      default_dir: defaultDir.trim() || null,
      startup_cmd: startupCmd.trim() || null,
      last_used_at: null,
      has_credential: false
    }
  }

  const submit = (): void => {
    if (!canConnect) return
    const portNum = Number(port)
    const validPort = Number.isFinite(portNum) && portNum > 0 ? portNum : undefined
    const auth = buildAuth()
    onConnect({
      host: host.trim(),
      port: validPort,
      user: user.trim(),
      auth,
      profile: appliedProfile ?? undefined
    })
    const name = editingProfileName ?? (saveAsProfile ? profileName.trim() : '')
    if (name) {
      onSaveProfile(buildProfile(name))
      persistCredential(name)
    }
    onClose()
  }

  const saveOnly = (): void => {
    const name = editingProfileName ?? profileName.trim()
    if (!canSaveProfile || !name) return
    onSaveProfile(buildProfile(name))
    persistCredential(name)
    onClose()
  }

  const trapTab = useFocusTrap(dialogRef, 'input:not([disabled]), button:not([disabled])')
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    trapTab(e)
  }

  const field = 'flex flex-col gap-[5px]'
  const fieldLabel =
    'block text-text-muted [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase'
  const textInput =
    'w-full bg-background border border-border rounded-lg text-text-primary [font:inherit] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] px-2.5 py-1.5'

  return (
    <div
      className={MODAL_SCRIM_CLS}
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        className="pop w-[420px] max-w-[92vw] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-connect-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div
          className="px-3.5 py-[11px] border-b border-divider [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary"
          id="ssh-connect-title"
        >
          Connect over SSH
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="flex gap-2.5">
            <div className={`${field} flex-1 min-w-0`}>
              <label className={fieldLabel}>Host</label>
              <input
                ref={hostInputRef}
                type="text"
                className={textInput}
                value={host}
                onChange={(e) => edited(setHost)(e.target.value)}
                onBlur={markTouched('host')}
                placeholder="example.com"
                spellCheck={false}
                aria-invalid={hostError ? true : undefined}
                aria-describedby={hostError ? 'ssh-host-error' : undefined}
              />
              {hostError && (
                <div id="ssh-host-error" className="text-danger [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]" role="alert">
                  {hostError}
                </div>
              )}
            </div>
            <div className={`${field} flex-none w-20`}>
              <label className={fieldLabel}>Port</label>
              <input
                type="number"
                className={textInput}
                value={port}
                onChange={(e) => edited(setPort)(e.target.value)}
                placeholder={String(DEFAULT_PORT)}
              />
            </div>
          </div>
          <div className={field}>
            <label className={fieldLabel}>User</label>
            <input
              type="text"
              className={textInput}
              value={user}
              onChange={(e) => edited(setUser)(e.target.value)}
              onBlur={markTouched('user')}
              placeholder="user"
              spellCheck={false}
              aria-invalid={userError ? true : undefined}
              aria-describedby={userError ? 'ssh-user-error' : undefined}
            />
            {userError && (
              <div id="ssh-user-error" className="text-danger [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]" role="alert">
                {userError}
              </div>
            )}
          </div>
          <div className={field}>
            <label className={fieldLabel}>Auth</label>
            <div className="flex border border-border rounded-[var(--tr-radius-sm)] overflow-hidden w-max">
              <button
                type="button"
                className={`btn border-0 border-r border-divider last:border-r-0 rounded-none px-3 py-1 ${
                  authKind === 'agent'
                    ? 'bg-[var(--accent-muted)] text-primary font-semibold'
                    : 'bg-background text-text-muted'
                }`}
                onClick={() => edited(setAuthKind)('agent')}
              >
                SSH agent
              </button>
              <button
                type="button"
                className={`btn border-0 border-r border-divider last:border-r-0 rounded-none px-3 py-1 ${
                  authKind === 'identity_file'
                    ? 'bg-[var(--accent-muted)] text-primary font-semibold'
                    : 'bg-background text-text-muted'
                }`}
                onClick={() => edited(setAuthKind)('identity_file')}
              >
                Identity file
              </button>
              <button
                type="button"
                className={`btn border-0 border-r border-divider last:border-r-0 rounded-none px-3 py-1 ${
                  authKind === 'password'
                    ? 'bg-[var(--accent-muted)] text-primary font-semibold'
                    : 'bg-background text-text-muted'
                }`}
                onClick={() => edited(setAuthKind)('password')}
              >
                Password
              </button>
              <button
                type="button"
                className={`btn border-0 border-r border-divider last:border-r-0 rounded-none px-3 py-1 ${
                  authKind === 'ssh_config'
                    ? 'bg-[var(--accent-muted)] text-primary font-semibold'
                    : 'bg-background text-text-muted'
                }`}
                onClick={() => edited(setAuthKind)('ssh_config')}
              >
                ssh config
              </button>
            </div>
            {authKind === 'ssh_config' && (
              <div className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.55]">
                Uses <code>~/.ssh/config</code> for this host: HostName, User, Port and
                IdentityFile. Other options (ProxyJump, Match, Include) are <em>not</em> applied —
                anything you type above wins over the file.
              </div>
            )}
          </div>
          {authKind === 'identity_file' && (
            <div className={field}>
              <label className={fieldLabel}>Identity file</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className={`flex-1 min-w-0 ${textInput}`}
                  value={identityPath}
                  onChange={(e) => edited(setIdentityPath)(e.target.value)}
                  onBlur={markTouched('identity')}
                  placeholder="~/.ssh/id_ed25519"
                  spellCheck={false}
                  aria-invalid={identityError ? true : undefined}
                  aria-describedby={identityError ? 'ssh-identity-error' : undefined}
                />
                <button type="button" className={`btn ${BTN_GHOST}`} onClick={() => void choosePath()}>
                  Choose…
                </button>
              </div>
              {identityError && (
                <div id="ssh-identity-error" className="text-danger [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]" role="alert">
                  {identityError}
                </div>
              )}
            </div>
          )}
          {authKind === 'password' && (
            <div className={field}>
              <label className={fieldLabel} htmlFor="ssh-password">
                Password
              </label>
              <div className="flex gap-2 items-center">
                <input
                  id="ssh-password"
                  type="password"
                  className={`flex-1 min-w-0 ${textInput}`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={credentialStored ? '•••••••• (saved)' : 'Password'}
                  autoComplete="off"
                  spellCheck={false}
                />
                {credentialStored && (
                  <button
                    type="button"
                    className={`btn ${BTN_GHOST}`}
                    onClick={() => {
                      onClearCredential?.(credentialProfileName)
                      setPassword('')
                    }}
                  >
                    Forget
                  </button>
                )}
              </div>
              <div className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.55]">
                {keyringError
                  ? `Your system keychain is unreachable, so a saved password cannot be shown or used right now — it has not been lost. (${keyringError})`
                  : credentialStored
                    ? 'Stored in your system keychain. Houston’s database never holds it.'
                    : 'Saved to your system keychain when you save this profile — never to Houston’s database. Needs a profile name.'}
              </div>
            </div>
          )}
          <div className={field}>
            <label className={fieldLabel} htmlFor="ssh-default-dir">
              Start in directory
            </label>
            <input
              id="ssh-default-dir"
              type="text"
              className={textInput}
              value={defaultDir}
              onChange={(e) => setDefaultDir(e.target.value)}
              placeholder="~/srv/app  (optional)"
              spellCheck={false}
            />
          </div>
          <div className={field}>
            <label className={fieldLabel} htmlFor="ssh-startup-cmd">
              Run on connect
            </label>
            <input
              id="ssh-startup-cmd"
              type="text"
              className={textInput}
              value={startupCmd}
              onChange={(e) => setStartupCmd(e.target.value)}
              placeholder="tmux attach  (optional)"
              spellCheck={false}
            />
            <div className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.55]">
              {defaultDir.trim() === '' && startupCmd.trim() === ''
                ? 'Both are saved with a profile and applied each time you connect with it.'
                : 'Saved with the profile — an ad-hoc connect does not keep these.'}
            </div>
          </div>
          {recent.length > 0 && editingProfileName === null && (
            <div className={field}>
              <label className={fieldLabel}>Recent</label>
              <div className="flex flex-wrap gap-2 items-center" data-testid="ssh-recent">
                {recent.map((p) => (
                  <Tooltip key={p.name} label={`Connect to ${p.user}@${p.host}:${p.port}`}>
                    <button
                      type="button"
                      className="inline-flex items-baseline gap-[7px] bg-surface border border-border rounded-full text-text-secondary py-[5px] px-3 font-semibold hover:border-border-hover"
                      onClick={() => connectProfile(p)}
                    >
                      {p.name}
                      <span className="text-[var(--text-faint)] font-normal [font-size:var(--tr-text-small-size)] uppercase">
                        {p.user}@{p.host}
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}
          {configHosts && configHosts.length > 0 && editingProfileName === null && (
            <div className={field}>
              <label className={fieldLabel}>From ~/.ssh/config</label>
              <div className="flex flex-wrap gap-2 items-center" data-testid="ssh-config-hosts">
                {configHosts.map((h) => (
                  <Tooltip key={h.alias} label={`Fill the form from ~/.ssh/config: ${h.hostname}`}>
                    <button
                      type="button"
                      className="inline-flex items-baseline gap-[7px] bg-surface border border-border border-dashed rounded-full text-text-secondary py-[5px] px-3 hover:border-border-hover"
                      onClick={() => importConfigHost(h)}
                    >
                      {h.alias}
                      <span className="text-[var(--text-faint)] font-normal [font-size:var(--tr-text-small-size)] uppercase">
                        {h.hostname}
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </div>
              <div className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.55]">
                Only HostName, User, Port and IdentityFile are read. Hosts with patterns
                (<code>Host *.internal</code>) are rules rather than machines, so they are not
                listed.
              </div>
            </div>
          )}
          <div className={field}>
            <label className={fieldLabel}>Saved profiles</label>
            {editingProfileName ? (
              <div
                className="flex items-center gap-2 bg-surface border border-border rounded-lg pt-[5px] pr-2.5 pb-[5px] pl-3"
                role="status"
                aria-live="polite"
              >
                <span className="text-text-muted flex-none">
                  <Icon glyph={IconPencil} role="small" />
                </span>
                <span className="flex-1 min-w-0 truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-secondary">
                  Editing <span className="text-text-primary font-semibold">{editingProfileName}</span>
                </span>
                <button type="button" className={`btn ${BTN_GHOST}`} onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            ) : profiles.length === 0 ? (
              <div className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.55]">No saved profiles yet.</div>
            ) : (
              <div className="flex flex-wrap gap-2 items-center">
                {profiles.map((p) => (
                  <span
                    key={p.name}
                    className="group inline-flex items-stretch bg-surface border border-border rounded-full overflow-hidden hover:border-border-hover"
                  >
                    <Tooltip label={`${p.user}@${p.host}:${p.port}`}>
                      <button
                        type="button"
                        className="btn inline-flex items-baseline gap-[7px] border-0 rounded-none bg-transparent text-text-secondary pt-[5px] pr-1 pb-[5px] pl-3 font-semibold"
                        onClick={() => applyProfile(p)}
                      >
                        {p.name}
                        <span className="text-[var(--text-faint)] font-normal [font-size:var(--tr-text-small-size)] uppercase">
                          {p.user}@{p.host}
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip label={`Edit profile ${p.name}`}>
                      <button
                        type="button"
                        className="btn border-0 rounded-none bg-transparent text-[var(--text-faint)] py-0 px-1.5 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-text-primary"
                        aria-label={`Edit profile ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          startEdit(p)
                        }}
                      >
                        <Icon glyph={IconPencil} role="label" />
                      </button>
                    </Tooltip>
                    <Tooltip label={`Duplicate profile ${p.name}`}>
                      <button
                        type="button"
                        className="btn border-0 rounded-none bg-transparent text-[var(--text-faint)] py-0 px-1.5 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-text-primary"
                        aria-label={`Duplicate profile ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          duplicateProfile(p)
                        }}
                      >
                        <Icon glyph={IconCopy} role="label" />
                      </button>
                    </Tooltip>
                    <Tooltip label="Delete profile">
                      <button
                        type="button"
                        className="btn border-0 rounded-none bg-transparent text-[var(--text-faint)] py-0 pr-2.5 pl-1.5 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"
                        aria-label="Delete profile"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDeleteProfile(p.name)
                        }}
                      >
                        <Icon glyph={IconClose} role="label" />
                      </button>
                    </Tooltip>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {editingProfileName !== null ? (
              <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-secondary">
                Saving as <span className="text-text-primary font-semibold">{editingProfileName}</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-primary">
                  <Toggle on={saveAsProfile} onChange={setSaveAsProfile} data-testid="ssh-save-as-profile" />
                  <span>Save as profile</span>
                </div>
                {saveAsProfile && (
                  <input
                    type="text"
                    className={textInput}
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="profile name…"
                    spellCheck={false}
                  />
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-5">
          <div className="flex gap-2 justify-end">
            <button type="button" className={`btn ${BTN_GHOST}`} onClick={onClose}>
              Cancel <span className="opacity-55 font-normal">esc</span>
            </button>
            <Tooltip
              label={
                canSaveProfile
                  ? undefined
                  : 'Check "Save as profile" and name it (or edit an existing profile) first'
              }
            >
              <button type="button" className={`btn ${BTN_GHOST}`} disabled={!canSaveProfile} onClick={saveOnly}>
                Save without connecting
              </button>
            </Tooltip>
            <button type="button" className={`btn ${BTN_PRIMARY}`} disabled={!canConnect} onClick={submit}>
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
