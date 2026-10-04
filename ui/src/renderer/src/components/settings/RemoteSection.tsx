import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { REMOTE_NOTIFY_DELAY_MAX_SECS } from '../../houston/generated/DEFAULTS'
import type { RemoteDevice } from '../../houston/generated/RemoteDevice'
import type { RemoteNotifyDetail } from '../../houston/generated/RemoteNotifyDetail'
import { plainHttpOffLoopback, useRemote } from '../../houston/useRemote'
import { Select, type SelectOption } from '../Select'
import { SettingsList, Toggle } from '../settingsPrimitives'
import { Button, Notice, QrImage, TextInput } from '../ui'
import { NumberSetting, Row, SectionHead, SubHead } from './shared'

const DETAIL_OPTIONS: SelectOption[] = [
  { value: 'generic', label: 'Generic message' },
  { value: 'pane_name', label: 'Include the pane name' }
]

function relative(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return new Date(ms).toLocaleDateString()
}

/// Commits on blur or Enter when the text changed; the daemon validates.
function TextSetting({
  value,
  label,
  placeholder,
  type = 'text',
  width = 'lg',
  mono = false,
  testId,
  onCommit
}: {
  value: string
  label: string
  placeholder?: string
  type?: 'text' | 'password' | 'url'
  width?: 'md' | 'lg'
  mono?: boolean
  testId: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft.trim() !== value) onCommit(draft.trim())
  }
  return (
    <TextInput
      aria-label={label}
      data-testid={testId}
      type={type}
      width={width}
      mono={mono}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

function DeviceRow({ device, onRevoke }: { device: RemoteDevice; onRevoke: (id: number) => void }): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(id)
  }, [armed])
  return (
    <Row
      title={device.name}
      desc={`Paired ${new Date(device.created_at).toLocaleDateString()} · last seen ${relative(device.last_seen_at)}`}
    >
      <Button
        variant="danger"
        size="sm"
        armed={armed}
        data-testid={`settings-remote-revoke-${device.id}`}
        onClick={() => (armed ? onRevoke(device.id) : setArmed(true))}
      >
        {armed ? 'Confirm revoke' : 'Revoke'}
      </Button>
    </Row>
  )
}

/// Settings ▸ Remote access: the listener, paired devices and ntfy notifications.
export function RemoteSection({ client }: { client: HoustonClient | null }): React.JSX.Element {
  const { remote, pairing, error, configure, pairStart, pairCancel, revoke } = useRemote(client)
  const [ntfyDraft, setNtfyDraft] = useState('')

  return (
    <>
      <SectionHead
        title="Remote access"
        lede="Follow and answer panes from a phone or another computer. Off by default: nothing listens and nothing is sent until you turn it on."
      />
      {error && (
        <div data-testid="settings-remote-error">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
      {!remote ? (
        <Notice tone="info">Asking the daemon for its remote access settings.</Notice>
      ) : (
        <>
          <SubHead>Listener</SubHead>
          <SettingsList>
            <Row
              title="Allow remote access"
              desc="Serves a small web app to devices you pair. A paired device can read any pane and type into it, which is as much access as a shell on this computer."
            >
              <Toggle
                on={remote.enabled}
                onChange={(enabled) => configure({ enabled })}
                data-testid="settings-remote-enabled"
              />
            </Row>
            <Row title="Listen address" desc="IP and port. Keep 127.0.0.1 and publish it with tailscale serve for HTTPS on your tailnet.">
              <TextSetting
                label="Listen address"
                testId="settings-remote-bind"
                width="md"
                mono
                value={remote.bind}
                onCommit={(bind) => configure({ bind })}
              />
            </Row>
            <Row title="Public URL" desc="The address devices open, such as https://machine.tailnet.ts.net. Empty uses the listen address.">
              <TextSetting
                label="Public URL"
                testId="settings-remote-public-url"
                type="url"
                placeholder={`http://${remote.bind}`}
                value={remote.public_url ?? ''}
                onCommit={(public_url) => configure({ public_url })}
              />
            </Row>
            <Row
              title="Status"
              desc={
                <span data-testid="settings-remote-status">
                  {!remote.enabled
                    ? 'Off.'
                    : remote.listening
                      ? `Listening. Devices open ${remote.url}`
                      : remote.error
                        ? `Not listening: ${remote.error}`
                        : 'Starting.'}
                </span>
              }
            />
          </SettingsList>
          {remote.enabled && plainHttpOffLoopback(remote) && (
            <div data-testid="settings-remote-plain-http">
              <Notice tone="warn">
                Devices reach this address over plain HTTP, so their token and the pane text they read cross the network unencrypted. Use tailscale serve and an https public URL.
              </Notice>
            </div>
          )}

          <SubHead>Devices</SubHead>
          <SettingsList>
            <Row
              title="Pair a device"
              desc={
                pairing
                  ? `Scan the code or open the link on the device. It works once and expires at ${new Date(pairing.expiresAt).toLocaleTimeString()}.`
                  : 'Shows a single-use code that expires after 10 minutes.'
              }
            >
              {pairing ? (
                <Button variant="ghost" size="sm" onClick={pairCancel} data-testid="settings-remote-pair-cancel">
                  Hide code
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!remote.enabled}
                  onClick={pairStart}
                  data-testid="settings-remote-pair"
                >
                  Pair a device
                </Button>
              )}
            </Row>
            {pairing && (
              <Row title={<QrImage svg={pairing.qrSvg} label="Pairing code" />}>
                <TextInput
                  aria-label="Pairing link"
                  data-testid="settings-remote-pair-url"
                  width="lg"
                  mono
                  readOnly
                  value={pairing.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </Row>
            )}
            {remote.devices.length === 0 ? (
              <Row title="No devices paired" />
            ) : (
              remote.devices.map((device) => <DeviceRow key={device.id} device={device} onRevoke={revoke} />)
            )}
          </SettingsList>

          <SubHead>Notifications</SubHead>
          <SettingsList>
            <Row
              title="ntfy topic URL"
              desc={
                remote.ntfy_server
                  ? `On: sending to ${remote.ntfy_server}. The topic URL is kept in the OS keychain.`
                  : 'Off. Paste a topic URL such as https://ntfy.sh/<unguessable-name>.'
              }
            >
              <div className="flex items-center gap-[var(--space-2)]">
                <TextInput
                  aria-label="ntfy topic URL"
                  data-testid="settings-remote-ntfy-url"
                  type="password"
                  width="md"
                  placeholder={remote.ntfy_server ? 'Replace topic URL' : 'https://ntfy.sh/topic'}
                  value={ntfyDraft}
                  onChange={(event) => setNtfyDraft(event.target.value)}
                />
                <Button
                  size="sm"
                  disabled={ntfyDraft.trim() === ''}
                  data-testid="settings-remote-ntfy-save"
                  onClick={() => {
                    configure({ ntfy_url: ntfyDraft.trim() })
                    setNtfyDraft('')
                  }}
                >
                  Save
                </Button>
                {remote.ntfy_server && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="settings-remote-ntfy-clear"
                    onClick={() => configure({ ntfy_url: '' })}
                  >
                    Turn off
                  </Button>
                )}
              </div>
            </Row>
            <Row title="Delay" desc="How long a pane waits for input before the notification goes out. Answering sooner sends nothing.">
              <NumberSetting
                value={remote.notify_delay_secs}
                max={REMOTE_NOTIFY_DELAY_MAX_SECS}
                unit="s"
                testId="settings-remote-delay"
                onCommit={(notify_delay_secs) => configure({ notify_delay_secs })}
              />
            </Row>
            <Row title="Message" desc="The generic message names no pane; the other adds the pane's title.">
              <Select
                aria-label="Notification message"
                data-testid="settings-remote-detail"
                value={remote.notify_detail}
                options={DETAIL_OPTIONS}
                onChange={(value) => configure({ notify_detail: value as RemoteNotifyDetail })}
              />
            </Row>
            <Row title="Also when a turn finishes" desc="Notify when a working agent settles at idle.">
              <Toggle
                on={remote.notify_finished}
                onChange={(notify_finished) => configure({ notify_finished })}
                data-testid="settings-remote-finished"
              />
            </Row>
          </SettingsList>
          <Notice tone="info">
            What is sent: the title Houston, the message, and a link to this listener, posted to the ntfy server above while remote access is on. Terminal content, commands and paths are never sent. Anyone who knows the topic URL can read these messages.
          </Notice>
        </>
      )}
    </>
  )
}
