import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { REMOTE_NOTIFY_DELAY_MAX_SECS } from '../../houston/generated/DEFAULTS'
import type { RemoteDevice } from '../../houston/generated/RemoteDevice'
import type { RemoteInfo } from '../../houston/generated/RemoteInfo'
import type { RemoteNotifyDetail } from '../../houston/generated/RemoteNotifyDetail'
import type { RemoteTier } from '../../houston/generated/RemoteTier'
import { plainHttpOffLoopback, useRemote } from '../../houston/useRemote'
import { Select, type SelectOption } from '../ui/Select'
import { SettingsList, Toggle } from '../ui/settingsPrimitives'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { NumberField, NumberFieldUnit } from '../ui/NumberField'
import { Button, CheckStateDot, DialogActions, DialogBackdrop, DialogBody, DialogDescription, DialogPanel, DialogTitle, Field, Notice, Text, TextInput } from '../ui'
import { Row, SubHead } from './shared'
import { RemotePairing, deviceActivity } from './RemotePairing'
import { SettingsDisclosure } from '../ui/SettingsDisclosure'
import { Card } from '../ui/Card'
import { SectionHead } from '../ui/SectionHead'
import { Inline } from '../ui/Inline'
import { SetupDot } from '../ui/AgentSetupRow'

const DETAIL_OPTIONS: SelectOption[] = [
  { value: 'generic', label: 'Generic message' },
  { value: 'pane_name', label: 'Include the pane name' }
]

export const TIER_OPTIONS: SelectOption[] = [
  { value: 'observe', label: 'Observe', title: 'Reads panes, changes, pull requests, tasks and usage.' },
  { value: 'drive', label: 'Drive', title: 'Also answers panes: types, decides and dictates.' },
  { value: 'manage', label: 'Manage', title: 'Also opens, renames, restarts, sleeps and closes panes, and commits or pushes.' }
]

const OFF_REASON = 'Turn on remote access first.'

const HTTP_WARNING =
  'Devices reach this address over plain HTTP, so their token and the pane text they read cross the network unencrypted. Use the Tailscale route, or a private network address, where Houston serves HTTPS itself.'

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
}

type RouteKind = 'Tailscale' | 'Same Wi-Fi' | 'Custom'

/// Mirrors the Connect phone dialog's two routes: Tailscale is loopback behind an
/// https URL, Same Wi-Fi is every interface behind a private address that Houston
/// serves over its own HTTPS (plain HTTP before it could). Anything else is Custom.
export function routeKind(remote: Pick<RemoteInfo, 'bind' | 'public_url' | 'tls'>): RouteKind {
  const host = remote.bind.replace(/:\d+$/, '')
  const url = remote.public_url ?? ''
  if (host === '127.0.0.1' && url.startsWith('https://')) return 'Tailscale'
  if (host === '0.0.0.0' && (remote.tls || url.startsWith('http://'))) return 'Same Wi-Fi'
  return 'Custom'
}

function routeDescription(remote: RemoteInfo, kind: RouteKind): string {
  if (kind === 'Tailscale') return 'Uses the configured HTTPS address. Tailscale requires both devices on the same tailnet and HTTPS enabled.'
  if (kind === 'Same Wi-Fi') {
    return remote.tls
      ? "Devices on this network open Houston over HTTPS, with this computer's certificate."
      : 'Devices on this network open Houston over plain HTTP.'
  }
  if (remote.tls) return `Devices open ${remote.url} over HTTPS, with this computer's certificate.`
  return remote.public_url ? `Devices open ${remote.public_url}.` : 'No public URL: devices open the listen address.'
}

const BIND_SHAPE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/

export function bindError(value: string): string | null {
  const match = BIND_SHAPE.exec(value)
  const port = match ? Number(match[1]) : 0
  if (match && port >= 1 && port <= 65535) return null
  return `Listen address ${JSON.stringify(value)} must be IP:PORT with a port from 1 to 65535, such as 127.0.0.1:47823 or [::1]:47823.`
}

function BindDialog({
  bind,
  onSave,
  onClose
}: {
  bind: string
  onSave: (bind: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(bind)
  const [error, setError] = useState<string | null>(null)
  return (
    <DialogBackdrop onMouseDown={onClose}>
      <DialogPanel
        size="wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-bind-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const value = draft.trim()
            const invalid = bindError(value)
            if (invalid) return setError(invalid)
            if (value !== bind) onSave(value)
            onClose()
          }}
        >
          <DialogTitle id="remote-bind-title">Listen address</DialogTitle>
          <DialogBody>
            <DialogDescription>
              Where Houston listens on this computer. Keep 127.0.0.1 and publish it with tailscale serve for HTTPS on your tailnet, or use this computer's private network address and Houston serves HTTPS itself.
            </DialogDescription>
            <Field label="IP:PORT" error={error ?? undefined}>
              <TextInput
                autoFocus
                data-testid="settings-remote-bind-input"
                font="mono"
                width="wide"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setError(null)
                }}
              />
            </Field>
          </DialogBody>
          <DialogActions variant="row">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" data-testid="settings-remote-bind-save">Save</Button>
          </DialogActions>
        </form>
      </DialogPanel>
    </DialogBackdrop>
  )
}

function NtfyDialog({
  configured,
  onSave,
  onRemove,
  onClose
}: {
  configured: boolean
  onSave: (url: string) => void
  onRemove: () => void
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <DialogBackdrop onMouseDown={onClose}>
      <DialogPanel
        size="wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-ntfy-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim() === '') return
            onSave(draft.trim())
            onClose()
          }}
        >
          <DialogTitle id="remote-ntfy-title">ntfy topic</DialogTitle>
          <DialogBody>
            <DialogDescription>
              The topic URL is kept in the system keychain and is never shown again.
            </DialogDescription>
            <Field label="Topic URL" hint="Such as https://ntfy.sh/<unguessable-name>.">
              <TextInput
                autoFocus
                type="password"
                data-testid="settings-remote-ntfy-url"
                width="wide"
                placeholder={configured ? 'Replace topic URL' : 'https://ntfy.sh/topic'}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </Field>
          </DialogBody>
          <DialogActions variant="row">
            {configured && (
              <Button
                type="button"
                variant="danger"
                data-testid="settings-remote-ntfy-clear"
                onClick={() => {
                  onRemove()
                  onClose()
                }}
              >
                Remove
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={draft.trim() === ''} data-testid="settings-remote-ntfy-save">
              Save
            </Button>
          </DialogActions>
        </form>
      </DialogPanel>
    </DialogBackdrop>
  )
}

/// Like NumberSetting, which has no disabled state. The daemon validates the
/// value, so a refusal naming the limit is not swallowed by clamping here.
function DelaySetting({
  value,
  disabled,
  onCommit
}: {
  value: number
  disabled: boolean
  onCommit: (n: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Math.trunc(Number(draft))
    if (!Number.isFinite(n)) return setDraft(String(value))
    if (n !== value) onCommit(n)
  }
  return (
    <div className="flex items-center gap-[var(--space-2)]">
      <NumberField
        width="compact"
        min={0}
        max={REMOTE_NOTIFY_DELAY_MAX_SECS}
        step={1}
        value={draft}
        disabled={disabled}
        aria-label="Notification delay"
        data-testid="settings-remote-delay"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      <NumberFieldUnit>s</NumberFieldUnit>
    </div>
  )
}

function DeviceRow({
  device,
  enabled,
  onRevoke,
  onSetTier,
  now
}: {
  now: number
  device: RemoteDevice
  enabled: boolean
  onRevoke: (device: RemoteDevice) => void
  onSetTier: (device: RemoteDevice, tier: RemoteTier) => void
}): React.JSX.Element {
  const activity = deviceActivity(device.last_seen_at, now)
  const active = activity === 'Active now'
  return (
    <Row
      title={device.name}
      desc={`Paired ${shortDate(device.created_at)}`}
    >
      <Inline gap="large"><Select
        aria-label={`Access for ${device.name}`}
        data-testid={`settings-remote-tier-${device.id}`}
        value={device.tier}
        options={TIER_OPTIONS}
        disabled={!enabled}
        onChange={(tier) => onSetTier(device, tier as RemoteTier)}
      /><Inline gap="small"><SetupDot tone={active ? 'ok' : 'muted'} /><Text size="small" tone={active ? 'success' : 'muted'}>{activity}</Text></Inline><Button
        variant="muted-link"
        disabled={!enabled}
        data-testid={`settings-remote-revoke-${device.id}`}
        onClick={() => onRevoke(device)}
      >
        Revoke…
      </Button></Inline>
    </Row>
  )
}

/// Settings ▸ Phone & remote access: the listener, devices and ntfy notifications.
/// `onChangeRoute` opens the Connect phone dialog on its route step.
export function RemoteSection({
  client,
  onChangeRoute
}: {
  client: HoustonClient | null
  onChangeRoute: () => void
}): React.JSX.Element {
  const state = useRemote(client)
  const { remote, error, configure, revoke, setTier, regenerateCertificate } = state
  const [regenerating, setRegenerating] = useState(false)
  const [editingBind, setEditingBind] = useState(false)
  const [editingNtfy, setEditingNtfy] = useState(false)
  const [revoking, setRevoking] = useState<RemoteDevice | null>(null)
  useEffect(() => {
    if (remote && !remote.enabled) setEditingNtfy(false)
  }, [remote])

  return (
    <div className="grid gap-[var(--space-4)]">
      <RemotePairing state={state} onChangeRoute={onChangeRoute} />
      {remote?.enabled && plainHttpOffLoopback(remote) && <Notice tone="warn">{HTTP_WARNING}</Notice>}
      {error && (
        <div data-testid="settings-remote-error">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
      {!remote ? (
        <Notice tone="info">Asking the daemon for its remote access settings.</Notice>
      ) : (
        <RemoteGroups
          remote={remote}
          onConfigure={configure}
          onChangeRoute={onChangeRoute}
          onEditBind={() => setEditingBind(true)}
          onEditNtfy={() => setEditingNtfy(true)}
          onRevoke={setRevoking}
          onSetTier={(device, tier) => setTier(device.id, tier)}
          onRegenerate={() => setRegenerating(true)}
        />
      )}
      {remote && editingBind && (
        <BindDialog bind={remote.bind} onSave={(bind) => configure({ bind })} onClose={() => setEditingBind(false)} />
      )}
      {remote && editingNtfy && (
        <NtfyDialog
          configured={remote.ntfy_server !== null}
          onSave={(ntfy_url) => configure({ ntfy_url })}
          onRemove={() => configure({ ntfy_url: '' })}
          onClose={() => setEditingNtfy(false)}
        />
      )}
      {regenerating && (
        <ConfirmDialog
          title="Regenerate the certificate?"
          confirmLabel="Regenerate"
          onCancel={() => setRegenerating(false)}
          onConfirm={() => {
            regenerateCertificate()
            setRegenerating(false)
          }}
        >
          <Text size="small" tone="secondary">
            Every paired device must trust the new certificate from the pairing page before it can connect again.
          </Text>
        </ConfirmDialog>
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          confirmLabel="Revoke"
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            revoke(revoking.id)
            setRevoking(null)
          }}
        >
          <Text size="small" tone="secondary">
            It loses access immediately and must pair again with a new code.
          </Text>
        </ConfirmDialog>
      )}
    </div>
  )
}

type RemoteGroupProps = {
  remote: RemoteInfo
  onConfigure: ReturnType<typeof useRemote>['configure']
  onChangeRoute: () => void
  onEditBind: () => void
  onEditNtfy: () => void
  onRevoke: (device: RemoteDevice) => void
  onSetTier: (device: RemoteDevice, tier: RemoteTier) => void
  onRegenerate: () => void
}

function RemoteGroups(props: RemoteGroupProps): React.JSX.Element {
  const { remote, onRevoke, onSetTier } = props
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    // Last-seen labels age without polling; minute precision matches their displayed units.
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return <>
    <SectionHead variant="section" title="Paired devices" count={remote.devices.length} />
    <SettingsList>{remote.devices.length ? remote.devices.map((device) => <DeviceRow key={device.id} device={device} enabled={remote.enabled} now={now} onRevoke={onRevoke} onSetTier={onSetTier} />) : <Row title="No devices paired" desc="Show a code above to pair your first device." />}</SettingsList>
    <Card shape="card"><SettingsDisclosure heading="Phone notifications" status={<Text size="small" tone="muted">{remote.ntfy_server ? `${remote.ntfy_server} · after ${remote.notify_delay_secs}s waiting` : 'Off'}</Text>}><RemoteNotifications {...props} /></SettingsDisclosure></Card>
    <Card shape="card"><SettingsDisclosure heading="Route and address" status={<Text size="small" tone="muted">{routeKind(remote)} · {remote.bind}</Text>}><RemoteRoute {...props} /></SettingsDisclosure></Card>
    <Card shape="card"><SettingsDisclosure heading="Dictation" status={<Text size="small" tone="muted">{remote.dictation && remote.enabled ? 'On' : 'Off'}</Text>}><RemoteDictation {...props} /></SettingsDisclosure></Card>
  </>
}

function RemoteRoute({ remote, onConfigure, onChangeRoute, onEditBind, onRegenerate }: RemoteGroupProps): React.JSX.Element {
  const kind = routeKind(remote)
  const plainHttp = remote.enabled && plainHttpOffLoopback(remote)
  const status = !remote.enabled ? (
    <span data-testid="settings-remote-status">Off. Nothing listens and nothing is sent.</span>
  ) : remote.listening ? (
    <span data-testid="settings-remote-status" className="inline-flex items-center gap-[var(--space-2)]">
      <CheckStateDot state="passing" size="check" />
      Listening at {remote.url}
    </span>
  ) : remote.error ? (
    <span data-testid="settings-remote-status">
      <Text size="small" tone="danger">Not listening: {remote.error}</Text>
    </span>
  ) : (
    <span data-testid="settings-remote-status">Starting.</span>
  )

  return <>
      <SubHead>Access</SubHead>
      <SettingsList>
        <Row title="Allow remote access" desc={status}>
          <Toggle
            on={remote.enabled}
            onChange={(enabled) => onConfigure({ enabled })}
            aria-label="Allow remote access"
            data-testid="settings-remote-enabled"
          />
        </Row>
        <Row
          title="Route"
          desc={
            plainHttp ? (
              <span data-testid="settings-remote-plain-http">
                <Text size="small" tone="warn">{HTTP_WARNING}</Text>
              </span>
            ) : (
              routeDescription(remote, kind)
            )
          }
        >
          <div className="flex items-center gap-[var(--space-3)]">
            <Text size="small" tone="secondary" data-testid="settings-remote-route">{kind}</Text>
            <Button variant="ghost" size="sm" data-testid="settings-remote-route-change" onClick={onChangeRoute}>
              Change…
            </Button>
          </div>
        </Row>
        <Row title="Listen address" desc="Where Houston listens on this computer. Change it only for a LAN or tailnet address.">
          <div className="flex items-center gap-[var(--space-3)]">
            <Text size="small" mono tone="secondary" data-testid="settings-remote-bind">{remote.bind}</Text>
            <Button variant="ghost" size="sm" data-testid="settings-remote-bind-edit" onClick={onEditBind}>
              Edit…
            </Button>
          </div>
        </Row>
      </SettingsList>

      {(remote.tls || remote.ca_fingerprint) && (
        <>
          <SubHead>Certificate</SubHead>
          <SettingsList>
            <Row
              title="Fingerprint"
              desc={
                <span data-testid="settings-remote-ca-fingerprint">
                  {remote.ca_fingerprint ?? 'Created when Houston first serves HTTPS on this network.'}
                </span>
              }
            />
            <Row
              title="Regenerate certificate"
              desc="Makes a new certificate authority. Every device must trust the new one; remove the old one from each device."
            >
              <Button variant="ghost" size="sm" data-testid="settings-remote-ca-regenerate" onClick={onRegenerate}>
                Regenerate…
              </Button>
            </Row>
          </SettingsList>
          <Text as="p" size="small" tone="muted">
            On a private network address Houston serves HTTPS with a certificate authority this computer creates. Its private key stays in the system keychain, and it can certify only private network addresses and .local names. A device trusts it once, from the pairing page.
          </Text>
        </>
      )}

  </>
}

function RemoteDictation({ remote, onConfigure }: RemoteGroupProps): React.JSX.Element {
  return <>
      <SettingsList>
        <Row
          title="Allow dictation from paired devices"
          desc={
            remote.enabled
              ? "A paired device records speech and this computer transcribes it with the engine in Settings ▸ Dictation. This computer's microphone is not used, and desktop dictation does not need to be on."
              : `Off. ${OFF_REASON}`
          }
        >
          <Toggle
            on={remote.dictation}
            disabled={!remote.enabled}
            onChange={(dictation) => onConfigure({ dictation })}
            aria-label="Allow dictation from paired devices"
            data-testid="settings-remote-dictation"
          />
        </Row>
      </SettingsList>
      <Text as="p" size="small" tone="muted" data-testid="settings-remote-dictation-disclosure">
        With the local engine, each recording goes from the device to this computer only and is discarded after transcription. With Groq, each recording is also sent to Groq.
      </Text>

  </>
}

function RemoteNotifications({ remote, onConfigure, onEditNtfy }: RemoteGroupProps): React.JSX.Element {
  return <>
      <SettingsList>
        <Row
          title="ntfy topic"
          desc={
            remote.enabled
              ? 'Push to your phone when an agent waits for you. Stored in the system keychain.'
              : `Off. ${OFF_REASON}`
          }
        >
          <div className="flex items-center gap-[var(--space-3)]">
            <Text size="small" tone="secondary" data-testid="settings-remote-ntfy-server">
              {remote.ntfy_server ?? 'Off'}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              disabled={!remote.enabled}
              data-testid="settings-remote-ntfy-edit"
              onClick={onEditNtfy}
            >
              {remote.ntfy_server ? 'Change…' : 'Set up…'}
            </Button>
          </div>
        </Row>
        <Row title="Delay" desc="How long a pane waits before the notification goes out. Answering sooner sends nothing.">
          <DelaySetting
            value={remote.notify_delay_secs}
            disabled={!remote.enabled}
            onCommit={(notify_delay_secs) => onConfigure({ notify_delay_secs })}
          />
        </Row>
        <Row title="Message" desc="The generic message names no pane; the other adds the pane's title.">
          <Select
            aria-label="Notification message"
            data-testid="settings-remote-detail"
            disabled={!remote.enabled}
            value={remote.notify_detail}
            options={DETAIL_OPTIONS}
            onChange={(value) => onConfigure({ notify_detail: value as RemoteNotifyDetail })}
          />
        </Row>
        <Row title="Also when a turn finishes" desc="Notify when a working agent settles at idle.">
          <Toggle
            on={remote.notify_finished}
            disabled={!remote.enabled}
            onChange={(notify_finished) => onConfigure({ notify_finished })}
            aria-label="Also when a turn finishes"
            data-testid="settings-remote-finished"
          />
        </Row>
      </SettingsList>
      <Text as="p" size="small" tone="muted">
        ntfy receives the title Houston, the message and a link to this listener. Terminal content, commands and paths are never sent. Anyone who knows the topic URL can read these messages.
      </Text>
  </>
}
