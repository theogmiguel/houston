import { useEffect, useRef, useState } from 'react'
import type { SshAuth, SshConfigHost, SshProfile } from '../houston/client'
import { pickFile } from '../houston/bridge'
import { IconChevronRight } from './icons'
import { Icon } from './Icon'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from './buttonChrome'
import { Tooltip } from './Tooltip'
import { Toggle } from './settingsPrimitives'
import { MODAL_SCRIM_CLS } from './overlayChrome'
import { useFocusTrap } from './dialogFocus'

export interface SshConnectParams {
  host: string
  port?: number
  user: string
  auth: SshAuth
  profile?: string
  default_dir?: string
}

export interface SshInitial {
  host: string
  port?: number
  user: string
}

interface Props {
  profiles: SshProfile[]
  initial?: SshInitial | null
  onConnect: (params: SshConnectParams) => void | Promise<void>
  onSaveProfile: (profile: SshProfile) => void
  onSetCredential?: (profile: string, password: string) => void
  onClearCredential?: (profile: string) => void
  configHosts?: SshConfigHost[]
  keyringError?: string | null
  onLoadConfigHosts?: () => void
  onDeleteProfile: (name: string) => void
  onClose: () => void
}

export function validateSshFields(host: string, user: string, port: string, folder: string): string | null {
  if (!/^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,252}$/.test(host))
    return `Machine ${JSON.stringify(host)} must be 1–253 characters from A–Z, a–z, 0–9, dot, underscore, colon or hyphen, and must not start with a hyphen.`
  if (user !== '' && !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/.test(user))
    return `Username ${JSON.stringify(user)} must be at most 128 characters from A–Z, a–z, 0–9, dot, underscore or hyphen, and must not start with a hyphen.`
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    return `Port ${JSON.stringify(port)} must be a number from 1 to 65535.`
  if (folder !== '' && ((!folder.startsWith('/') && !folder.startsWith('~/')) || /[\x00-\x1f\x7f-\x9f]/.test(folder)))
    return `Folder ${JSON.stringify(folder)} must start with / or ~/ and contain no control characters.`
  return null
}

export function SshConnectModal({ initial, configHosts, onConnect, onLoadConfigHosts, onClose }: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLFormElement>(null)
  const [host, setHost] = useState(initial?.host ?? '')
  const [user, setUser] = useState(initial?.user ?? '')
  const [folder, setFolder] = useState('')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [advanced, setAdvanced] = useState(false)
  const [chooseKey, setChooseKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const trapTab = useFocusTrap(dialogRef, 'input:not([disabled]), button:not([disabled])')

  useEffect(() => { dialogRef.current?.querySelector('input')?.focus() }, [])
  useEffect(() => { onLoadConfigHosts?.() }, [onLoadConfigHosts])

  const edit = (setter: (value: string) => void, value: string): void => {
    setter(value)
    setError(null)
  }
  const submit = async (): Promise<void> => {
    if (busyRef.current) return
    const validation = validateSshFields(host, user, port, folder)
    if (validation) { setError(validation); return }
    busyRef.current = true
    setBusy(true)
    try {
      let auth: SshAuth = { kind: 'ssh_config' }
      if (chooseKey) {
        const path = await pickFile('')
        if (!path) return
        auth = { kind: 'identity_file', path, passphrase_profile: null }
      }
      const config = chooseKey ? configHosts?.find((entry) => entry.alias === host) : undefined
      await onConnect({
        host: config?.hostname ?? host,
        user: user || config?.user || '',
        port: Number(port) === 22 ? (config?.port ?? 22) : Number(port),
        auth,
        default_dir: folder || undefined
      })
      onClose()
    } catch (reason) {
      setError(String(reason))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const textInput = 'w-full min-w-0 h-[30px] px-2.5 bg-background border border-border rounded-[6px] text-text-primary text-[length:var(--tr-text-base)]'
  const labelClass = 'text-right text-[length:var(--tr-text-base)] text-text-primary'
  return (
    <div className={MODAL_SCRIM_CLS} onMouseDown={() => { if (!busyRef.current) onClose() }}>
      <form
        ref={dialogRef}
        className="pop w-[min(440px,calc(100vw-32px))] p-6 flex flex-col gap-4 bg-[var(--card-bg)] border border-border rounded-[14px] shadow-[var(--shadow-2)] max-h-[calc(100vh-32px)] overflow-y-auto motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)]"
        role="dialog" aria-modal="true" aria-labelledby="ssh-connect-title" aria-describedby="ssh-connect-description"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void submit() }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); if (!busyRef.current) onClose() }
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
            event.preventDefault()
            if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) void submit()
          }
          trapTab(event)
        }}
      >
        <header className="flex flex-col gap-2">
          <h2 id="ssh-connect-title" className="m-0 text-[length:var(--tr-text-xl)] font-semibold text-text-primary">Connect via SSH</h2>
          <p id="ssh-connect-description" className="m-0 text-[length:var(--tr-text-base)] text-text-primary">Open a terminal on a Linux or Mac machine over SSH.</p>
        </header>
        <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 items-center">
          <label className={labelClass} htmlFor="ssh-machine">Machine</label>
          <Tooltip label="Hostname, IP address, or a name from your SSH config">
            <input id="ssh-machine" className={textInput} value={host} onChange={(event) => edit(setHost, event.target.value)} placeholder="server or SSH config name" autoFocus autoComplete="off" spellCheck={false} disabled={busy} />
          </Tooltip>
          <label className={labelClass} htmlFor="ssh-user">Username</label>
          <input id="ssh-user" className={textInput} value={user} onChange={(event) => edit(setUser, event.target.value)} placeholder="Use SSH configuration" autoComplete="off" spellCheck={false} disabled={busy} />
          <label className={labelClass} htmlFor="ssh-folder">Folder</label>
          <input id="ssh-folder" className={textInput} value={folder} onChange={(event) => edit(setFolder, event.target.value)} placeholder="~/projects/app" spellCheck={false} disabled={busy} />
          <button type="button" className={`btn ${BTN_GHOST} col-start-2 justify-self-start -ml-2.5 flex items-center gap-1 text-[length:var(--tr-text-base)]`} aria-expanded={advanced} aria-controls="ssh-advanced" onClick={() => setAdvanced(!advanced)}>
            <span className={advanced ? 'rotate-90' : ''}><Icon glyph={IconChevronRight} role="ui" /></span>Advanced
          </button>
          {advanced && <div id="ssh-advanced" className="contents">
            <label className={labelClass} htmlFor="ssh-port">Port</label>
            <input id="ssh-port" className={`${textInput} w-[88px] tabular-nums`} value={port} onChange={(event) => edit(setPort, event.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" maxLength={5} disabled={busy} />
            <label className="col-start-2 flex items-center gap-2 text-[length:var(--tr-text-base)] text-text-primary">
              <Toggle on={chooseKey} disabled={busy} onChange={(value) => { setChooseKey(value); setError(null) }} />
              <span id="ssh-key-label">Choose an SSH key when connecting</span>
            </label>
            <p className="col-start-2 m-0 text-[length:var(--tr-text-sm)] text-text-secondary">Otherwise, use your SSH agent or existing SSH configuration.</p>
          </div>}
          {error && <p role="alert" className="col-span-2 m-0 text-[length:var(--tr-text-sm)] text-danger">{error}</p>}
        </div>
        <footer className="flex items-center gap-2">
          <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={onClose}>Cancel</button>
          <span className="flex-1" />
          <button type="submit" className={`btn ${BTN_PRIMARY}`} disabled={host === '' || busy}>{busy ? 'Connecting…' : 'Connect'}</button>
        </footer>
      </form>
    </div>
  )
}
