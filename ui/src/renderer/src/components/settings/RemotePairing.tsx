import { useEffect, useState } from 'react'
import type { RemoteInfo } from '../../houston/generated/RemoteInfo'
import type { UseRemote } from '../../houston/useRemote'
import { TrustStep } from '../ConnectPhoneDialog'
import { useCopyFeedback } from '../useCopyFeedback'
import { Button, Inline, QrImage, Text, TextInput } from '../ui'
import { PageHeader } from '../ui/PageHeader'
import { PhonePairingCard, PairingStep, PairingSteps } from '../ui/PhonePairingCard'

export function deviceActivity(lastSeen: number | null | undefined, now: number): string {
  if (lastSeen == null) return 'Last seen not reported'
  const age = Math.max(0, now - lastSeen)
  if (age < 120_000) return 'Active now'
  const minutes = Math.floor(age / 60_000)
  if (minutes < 60) return `Last seen ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `Last seen ${hours}h ago`
  return `Last seen ${Math.floor(hours / 24)}d ago`
}

function hasPhoneRoute(remote: RemoteInfo): boolean {
  try {
    const url = new URL(remote.public_url ?? remote.url)
    return ['http:', 'https:'].includes(url.protocol) && !['localhost', '::1', '[::1]', '0.0.0.0', '[::]'].includes(url.hostname) && !url.hostname.startsWith('127.')
  } catch { return false }
}

function usePairingRequest(state: UseRemote, onChangeRoute: () => void): { pending: boolean; show: () => void; hide: () => void } {
  const { remote, pairing, error, configure, pairStart, pairCancel } = state
  const [waiting, setWaiting] = useState<'listener' | 'code' | null>(null)
  useEffect(() => {
    if (error || remote?.error || pairing || (waiting === 'code' && !remote?.enabled)) { setWaiting(null); return }
    if (waiting === 'listener' && remote?.enabled && remote.listening) {
      setWaiting('code')
      pairStart()
    }
  }, [remote, pairing, error, waiting, pairStart])
  const show = (): void => {
    if (!remote || !hasPhoneRoute(remote) || remote.error) { onChangeRoute(); return }
    if (remote.enabled && remote.listening) { setWaiting('code'); pairStart(); return }
    setWaiting('listener')
    configure({ enabled: true })
  }
  return { pending: waiting !== null, show, hide: () => { setWaiting(null); pairCancel() } }
}

function PairingCountdown({ expiresAt }: { expiresAt: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    // Pairing codes expire in minutes; the visible countdown ticks each second.
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return <>Single use · expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</>
}

function PairingInstructions({ pairing, remote }: Pick<UseRemote, 'pairing' | 'remote'>): React.JSX.Element {
  if (pairing) return <PairingSteps><PairingStep number={1} done heading="Listener ready" detail={<Text size="small" mono breakAll tone="muted">{remote?.url}</Text>} /><PairingStep number={2} heading="Waiting for your phone…" detail={<PairingCountdown expiresAt={pairing.expiresAt} />} /></PairingSteps>
  return <PairingSteps><PairingStep number={1} heading="Show a pairing code" detail="Houston starts listening on the route you pick: Tailscale, the same Wi-Fi, or a tunnel." /><PairingStep number={2} heading="Scan it with your phone’s camera" detail="The code works once and expires after 10 minutes." /><PairingStep number={3} heading="Add Houston to your home screen" detail="Optional: turn on notifications for when an agent waits for you." /></PairingSteps>
}

function PairingActions({ pairing, pending, disabled, show, hide, onChangeRoute }: Pick<UseRemote, 'pairing'> & { pending: boolean; disabled: boolean; show: () => void; hide: () => void; onChangeRoute: () => void }): React.JSX.Element {
  const { copyState, copy } = useCopyFeedback()
  return <><Inline gap="small" wrap>{pairing ? <><Button variant="secondary" onClick={hide}>Hide code</Button><Button variant="ghost" onClick={() => copy(pairing.url)}>{copyState === 'success' ? 'Copied' : 'Copy link instead'}</Button></> : <><Button variant="primary" disabled={pending || disabled} data-testid="settings-remote-connect-phone" onClick={show}>{pending ? 'Preparing code…' : 'Show pairing code'}</Button><Button variant="ghost" onClick={onChangeRoute}>Use another route</Button>{pending && <Button variant="ghost" onClick={hide}>Stop waiting</Button>}</>}</Inline>{pairing && copyState === 'error' && <TextInput aria-label="Pairing link" readOnly value={pairing.url} width="full" onFocus={(event) => event.currentTarget.select()} />}</>
}

export function RemotePairing({ state, onChangeRoute }: { state: UseRemote; onChangeRoute: () => void }): React.JSX.Element {
  const { remote, pairing } = state
  const { pending, show, hide } = usePairingRequest(state, onChangeRoute)
  return <div className="grid gap-[var(--space-5)]">
    <PageHeader heading="Phone & remote access" description="Follow and answer your agents from a phone or another computer. Houston serves this page only to devices you pair." />
    <PhonePairingCard code={pairing && <QrImage svg={pairing.qrSvg} label="Pairing code" />}>
      <div className="grid gap-[var(--space-1)]"><Text as="h2" size="subhead" weight="semibold" flush>{pairing ? 'Scan with your phone' : 'Connect a phone'}</Text><Text as="p" size="ui" tone="secondary" flush>{pairing ? 'Point the camera at the code to open Houston on your phone.' : 'See which agents need you, read their panes and answer them. Takes about a minute.'}</Text></div>
      <PairingInstructions pairing={pairing} remote={remote} />
      <PairingActions pairing={pairing} pending={pending} disabled={!remote} show={show} hide={hide} onChangeRoute={onChangeRoute} />
      {pairing && remote?.tls && <TrustStep fingerprint={remote.ca_fingerprint} />}
    </PhonePairingCard>
    <Text as="p" size="small" tone="muted" flush>A paired device can read and type into any pane, with as much access as a shell on this computer. {remote?.enabled ? `Configured address: ${remote.url}.` : 'Remote access is off. Showing a code turns it on at the route you choose.'}</Text>
  </div>
}
