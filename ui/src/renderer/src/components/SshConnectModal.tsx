import { LazyLegacyButton } from './ui/LazyLegacyButtonRoles'
import { useEffect, useRef, useState } from 'react'
import type { SshAuth, SshConfigHost, SshProfile } from '../houston/client'
import { pickFile } from '../houston/bridge'
import { Tooltip } from './ui/Tooltip'
import { Toggle } from './ui/settingsPrimitives'
import { Button, ContentsSwitch, DialogBackdrop, DialogForm, DisclosureChevron, FormGrid, FormGridLabel, Stack, Text, TextInput } from './ui'
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
  return (
    <DialogBackdrop onMouseDown={() => { if (!busyRef.current) onClose() }}>
      <DialogForm
        ref={dialogRef}
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
        <Stack as="header" gap={2}>
          <Text as="h2" size="xl" weight="semibold" tone="primary" flush id="ssh-connect-title">Connect via SSH</Text>
          <Text as="p" size="base" tone="primary" flush id="ssh-connect-description">Open a terminal on a Linux or Mac machine over SSH.</Text>
        </Stack>
        <FormGrid>
          <FormGridLabel htmlFor="ssh-machine">Machine</FormGridLabel>
          <Tooltip label="Hostname, IP address, or a name from your SSH config">
            <TextInput variant="form" id="ssh-machine" value={host} onChange={(event) => edit(setHost, event.target.value)} placeholder="server or SSH config name" autoFocus autoComplete="off" spellCheck={false} disabled={busy} />
          </Tooltip>
          <FormGridLabel htmlFor="ssh-user">Username</FormGridLabel>
          <TextInput variant="form" id="ssh-user" value={user} onChange={(event) => edit(setUser, event.target.value)} placeholder="Use SSH configuration" autoComplete="off" spellCheck={false} disabled={busy} />
          <FormGridLabel htmlFor="ssh-folder">Folder</FormGridLabel>
          <TextInput variant="form" id="ssh-folder" value={folder} onChange={(event) => edit(setFolder, event.target.value)} placeholder="~/projects/app" spellCheck={false} disabled={busy} />
          <LazyLegacyButton type="button" variant="legacy-ghost-disclosure" className="col-start-2 justify-self-start" aria-expanded={advanced} aria-controls="ssh-advanced" onClick={() => setAdvanced(!advanced)}>
            <DisclosureChevron open={advanced} />Advanced
          </LazyLegacyButton>
          {advanced && <ContentsSwitch shown id="ssh-advanced">
            <FormGridLabel htmlFor="ssh-port">Port</FormGridLabel>
            <TextInput variant="form" width="port" id="ssh-port" value={port} onChange={(event) => edit(setPort, event.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" maxLength={5} disabled={busy} />
            <Text as="label" size="base" tone="primary" className="col-start-2 flex items-center gap-[var(--space-2)]">
              <Toggle on={chooseKey} disabled={busy} onChange={(value) => { setChooseKey(value); setError(null) }} />
              <span id="ssh-key-label">Choose an SSH key when connecting</span>
            </Text>
            <Text as="p" size="sm" tone="secondary" flush id="ssh-advanced-description" className="col-start-2">Otherwise, use your SSH agent or existing SSH configuration.</Text>
          </ContentsSwitch>}
          {error && <Text as="p" size="sm" tone="danger" flush role="alert" className="col-span-2">{error}</Text>}
        </FormGrid>
        <footer className="flex items-center gap-[var(--space-2)]">
          <LazyLegacyButton type="button" variant="legacy-secondary" disabled={busy} onClick={onClose}>Cancel</LazyLegacyButton>
          <span className="flex-1" />
          <Button type="submit" variant="legacy-primary" disabled={host === '' || busy}>{busy ? 'Connecting…' : 'Connect'}</Button>
        </footer>
      </DialogForm>
    </DialogBackdrop>
  )
}
