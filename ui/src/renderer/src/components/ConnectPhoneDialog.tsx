import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNativeOverlaySuppression } from '../layout/nativeSuppression'
import { CONNECT_PHONE_EVENT, type ConnectPhoneStep } from '../connectPhone'
import type { HoustonClient } from '../houston/client'
import { useRemote, type RemotePairing } from '../houston/useRemote'
import { IconAlertTriangle, IconCheck } from './icons'
import { Button, DialogActions, DialogBackdrop, DialogBody, DialogDescription, DialogPanel, DialogTitle, FormGrid, FormGridLabel, Icon, IconTile, Inline, QrImage, Select, Spinner, Stack, Text, TextInput } from './ui'
import { useCopyFeedback } from './useCopyFeedback'
import { useFocusTrap } from './dialogFocus'

type Route = 'tailscale' | 'wifi'
type View = 'route' | 'scan'
const ROUTES = [
  { value: 'tailscale', label: 'Tailscale · HTTPS' },
  { value: 'wifi', label: 'Same Wi-Fi · HTTPS' }
]
const ROUTE_HINT: Record<Route, string> = {
  tailscale: 'Works anywhere; only your own devices can open it.',
  wifi: "Works on your home or office network; Houston listens on all interfaces and serves HTTPS with this computer's own certificate."
}
const SECURITY = 'A paired phone can read and type into any pane: as much access as a shell on this computer.'
const TRUST_NOTE = "The phone trusts this computer's certificate once, from the pairing page, before it connects."

/// Addresses this computer's certificate can name: private IPv4 and `.local`.
function certifiable(hostname: string): boolean {
  const ip = hostname.split('.').map(Number)
  if (ip.length === 4 && ip.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168)
  }
  return hostname.endsWith('.local') && hostname.length > '.local'.length
}

export function routeSettings(route: Route, port: string, value: string): { bind: string; public_url: string } | null {
  try {
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    if (route === 'tailscale' && url.protocol !== 'https:') return null
    if (route === 'wifi' && ((url.port || '443') !== port || url.protocol !== 'https:' || !certifiable(url.hostname))) return null
    return { bind: `${route === 'tailscale' ? '127.0.0.1' : '0.0.0.0'}:${port}`, public_url: url.origin }
  } catch {
    return null
  }
}

function WarningLine({ children }: { children: string }): React.JSX.Element {
  return (
    <Inline gap="small" align="start">
      <Text tone="muted"><Icon glyph={IconAlertTriangle} role="small" /></Text>
      <Text as="p" size="small" tone="muted" flush>{children}</Text>
    </Inline>
  )
}

function hostOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).host : ''
  } catch {
    return url ?? ''
  }
}

function portOf(remote: { bind: string } | null): string {
  return remote?.bind.match(/:(\d+)$/)?.[1] ?? ''
}

function addressError(route: Route, port: string, url: string, valid: boolean): string | undefined {
  if (url === '' || valid) return undefined
  const shape = route === 'tailscale'
    ? 'an HTTPS origin without credentials, a path, query, or fragment.'
    : `an HTTPS origin at port ${port} on this computer's private network address or .local name, without credentials, a path, query, or fragment.`
  return `Address ${JSON.stringify(url)} must be ${shape}`
}

type RemoteRoute = { bind: string; public_url?: string | null; enabled: boolean; listening: boolean }

function routeLive(remote: RemoteRoute | null, settings: { bind: string; public_url: string } | null): boolean {
  if (!remote || !settings || !remote.enabled || !remote.listening) return false
  return remote.bind === settings.bind && remote.public_url?.replace(/\/$/, '') === settings.public_url
}

function countdownOf(expiresAt: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.ceil(((expiresAt ?? now) - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function headingOf(confirmed: string | null, view: View | null): string {
  if (confirmed) return `${confirmed} is connected`
  return view === 'scan' ? 'Scan with your phone' : 'Connect a phone'
}

type CopyProps = { copyState: ReturnType<typeof useCopyFeedback>['copyState']; copyTarget: 'command' | 'link'; copyText: (target: 'command' | 'link', text: string) => void }

function ConnectedStep({ heading }: { heading: string }): React.JSX.Element {
  return (
    <Stack gap={3} align="center">
      <IconTile tone="success" size="lg" radius="medium" icon={<Icon glyph={IconCheck} role="ui" />} />
      <Text as="h2" size="subhead" tone="primary" flush center id="connect-phone-title">{heading}</Text>
      <Text as="p" size="base" tone="secondary" flush center>It can follow and answer every pane. Manage it in Settings ▸ Remote access.</Text>
    </Stack>
  )
}

function RouteStep({ route, port, url, fieldError, onRoute, onUrl, copyState, copyTarget, copyText }: {
  route: Route
  port: string
  url: string
  fieldError: string | undefined
  onRoute: (route: Route) => void
  onUrl: (url: string) => void
} & CopyProps): React.JSX.Element {
  const command = `tailscale serve --bg ${port}`
  const tailscale = route === 'tailscale'
  const noteId = 'connect-phone-address-note'
  return <>
    <DialogDescription>Follow and answer your panes when you are away from this computer.</DialogDescription>
    <FormGrid>
      <FormGridLabel>Route</FormGridLabel>
      <Select aria-label="Route" width="full" value={route} options={ROUTES} onChange={(value) => onRoute(value as Route)} />
      <Text as="p" size="small" tone="muted" flush className="col-start-2">{ROUTE_HINT[route]}</Text>
      {tailscale && <>
        <FormGridLabel htmlFor="connect-phone-command">Command</FormGridLabel>
        <Inline gap="small">
          <TextInput variant="form" id="connect-phone-command" font="mono" readOnly value={command} onFocus={(event) => event.currentTarget.select()} />
          <Button size="sm" onClick={() => copyText('command', command)}>{copyState === 'success' && copyTarget === 'command' ? 'Copied' : 'Copy'}</Button>
        </Inline>
      </>}
      <FormGridLabel htmlFor="connect-phone-address">Address</FormGridLabel>
      <TextInput variant="form" id="connect-phone-address" type="url" font="mono" value={url} placeholder={tailscale ? 'https://machine.tailnet.ts.net' : `https://192.168.1.20:${port}`} autoComplete="off" spellCheck={false} aria-invalid={!!fieldError} aria-describedby={noteId} onChange={(event) => onUrl(event.target.value)} />
      {fieldError
        ? <Text as="p" size="small" tone="danger" flush role="alert" id={noteId} className="col-start-2">{fieldError}</Text>
        : <Text as="p" size="small" tone="muted" flush id={noteId} className="col-start-2">{tailscale ? 'Paste the HTTPS address the command prints.' : `The computer's LAN address with port ${port}, as the phone reaches it.`}</Text>}
    </FormGrid>
    {!tailscale && <WarningLine>{TRUST_NOTE}</WarningLine>}
    <WarningLine>{SECURITY}</WarningLine>
    {copyState === 'error' && <Text as="p" size="small" tone="warn" flush role="status">Could not copy. Select the command and copy it manually.</Text>}
  </>
}

function PairingCode({ shown, expired, countdown, copyState, copyTarget, copyText }: { shown: RemotePairing; expired: boolean; countdown: string } & CopyProps): React.JSX.Element {
  return <>
    <QrImage svg={shown.qrSvg} label="Pairing code" dimmed={expired} />
    <Inline gap="small">
      <Text size="small" tone="muted">{expired ? 'Code expired' : `Single use · expires in ${countdown} ·`}</Text>
      {!expired && <Button variant="link" onClick={() => copyText('link', shown.url)}>{copyState === 'success' && copyTarget === 'link' ? 'Copied' : 'Copy link'}</Button>}
    </Inline>
    {copyState === 'error' && copyTarget === 'link' && <TextInput aria-label="Pairing link" readOnly value={shown.url} width="full" onFocus={(event) => event.currentTarget.select()} />}
  </>
}

/** The certificate trust step for a listener that serves its own HTTPS. */
function TrustStep({ fingerprint }: { fingerprint: string | null | undefined }): React.JSX.Element {
  return (
    <Stack gap={1}>
      <Text as="p" size="small" tone="secondary" flush>
        The first time, the phone warns that the connection is not private. Continue to the page, then follow <Text size="small" weight="semibold" tone="primary">Trust this computer</Text> there: Android installs the certificate, iPhone installs a profile and turns on full trust for it.
      </Text>
      {fingerprint && (
        <Text as="p" size="small" tone="muted" flush data-testid="connect-phone-fingerprint">
          Check that the page shows this fingerprint: <Text size="small" mono breakAll tone="secondary">{fingerprint}</Text>
        </Text>
      )}
    </Stack>
  )
}

function ScanStep({ shown, expired, countdown, waiting, loading, fieldError, trust, fingerprint, ...copy }: {
  shown: RemotePairing | null
  expired: boolean
  countdown: string
  waiting: boolean
  /** The loading line, or null when an error replaces it. */
  loading: string | null
  fieldError: string | undefined
  /** The listener serves its own HTTPS, so the phone trusts its certificate first. */
  trust: boolean
  fingerprint: string | null | undefined
} & CopyProps): React.JSX.Element {
  return <>
    <DialogDescription>Open the camera and point it at the code.</DialogDescription>
    <Stack gap={2} align="center">
      {shown
        ? <PairingCode shown={shown} expired={expired} countdown={countdown} {...copy} />
        : loading && <Inline gap="small"><Spinner label="Loading" /><Text size="small" tone="muted">{loading}</Text></Inline>}
    </Stack>
    {waiting && <Inline gap="small" className="justify-center"><Spinner label="Waiting" /><Text size="small" tone="muted">Waiting for the phone to confirm…</Text></Inline>}
    {trust && shown && !expired && <TrustStep fingerprint={fingerprint} />}
    {fieldError && <Text as="p" size="small" tone="danger" flush role="alert">{fieldError}</Text>}
  </>
}

function ConnectPhoneActions({ confirmed, view, expired, routeSummary, submitLabel, canSubmit, dismiss, onClose, onAnother, onChangeRoute, onRetry, onSubmit }: {
  confirmed: boolean
  view: View | null
  expired: boolean
  routeSummary: string
  submitLabel: string
  canSubmit: boolean
  dismiss: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onAnother: () => void
  onChangeRoute: () => void
  onRetry: () => void
  onSubmit: () => void
}): React.JSX.Element {
  if (confirmed) return <>
    <Button onClick={onAnother}>Connect another</Button>
    <span className="flex-1" />
    <Button ref={dismiss} variant="primary" onClick={onClose}>Done</Button>
  </>
  if (view === 'scan') return <>
    <Button variant="ghost" onClick={onChangeRoute}>{routeSummary}</Button>
    <span className="flex-1" />
    {expired
      ? <Button ref={dismiss} variant="primary" onClick={onRetry}>Get a new code</Button>
      : <Button ref={dismiss} variant="primary" onClick={onClose}>Close</Button>}
  </>
  return <>
    <Button ref={dismiss} variant="secondary" onClick={onClose}>Cancel</Button>
    <span className="flex-1" />
    <Button variant="primary" disabled={!canSubmit} onClick={onSubmit}>{submitLabel}</Button>
  </>
}

function scanLoading(remoteError: string | undefined, pending: boolean, live: boolean): string | null {
  if (remoteError) return null
  return pending || !live ? 'Starting remote access…' : 'Creating a single-use code…'
}

function routeSummaryOf(route: Route, publicUrl: string | null | undefined): string {
  return `${route === 'tailscale' ? 'Tailscale' : 'Same Wi-Fi'} · ${hostOf(publicUrl)} · Change`
}

function submitLabelOf(pending: boolean, live: boolean): string {
  if (pending) return 'Turning on…'
  return live ? 'Show code' : 'Turn on and show code'
}

/** `initialStep` forces the route step (`'route'`) or the code step (`'scan'`); without it the dialog opens on the code step when remote access is already on with a public URL. */
export function ConnectPhoneDialog({ client, onClose, initialStep }: { client: HoustonClient | null; onClose: () => void; initialStep?: ConnectPhoneStep }): React.JSX.Element {
  const { remote, pairing, error, configure, pairStart, pairCancel } = useRemote(client)
  const [view, setView] = useState<View | null>(null)
  const [route, setRoute] = useState<Route>('tailscale')
  const [url, setUrl] = useState('')
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [pending, setPending] = useState(false)
  const [issued, setIssued] = useState<RemotePairing | null>(null)
  const [copyTarget, setCopyTarget] = useState<'command' | 'link'>('command')
  const expected = useRef<{ bind: string; public_url: string } | null>(null)
  const baseline = useRef<Set<number> | null>(null)
  const requested = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const dismiss = useRef<HTMLButtonElement>(null)
  // A single selector branch preserves control order across DOM selector engines.
  const trapFocus = useFocusTrap(root, ':is(button, input, [tabindex="0"]):not([disabled])')
  useNativeOverlaySuppression('modal', true, root)
  const { copy, copyState } = useCopyFeedback()
  const port = portOf(remote)
  const settings = routeSettings(route, port, url)
  const remoteError = error ?? remote?.error ?? undefined
  const fieldError = addressError(route, port, url, !!settings) ?? remoteError
  const live = routeLive(remote, settings)
  const shown = pairing ?? issued
  const expired = view === 'scan' && !pairing && !!issued

  useEffect(() => {
    const trigger = document.activeElement
    return () => {
      pairCancel()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [pairCancel])

  useEffect(() => {
    if (!remote || view) return
    setRoute(remote.bind.startsWith('0.0.0.0:') ? 'wifi' : 'tailscale')
    setUrl(remote.public_url ?? '')
    setView(initialStep === 'route' || !remote.enabled || !remote.public_url ? 'route' : 'scan')
  }, [remote, view, initialStep])

  useEffect(() => {
    if (!remote) return
    if (baseline.current && remote.devices.length > baseline.current.size) {
      const device = remote.devices.find((device) => !baseline.current?.has(device.id))
      if (device) {
        setConfirmed(device.name)
        baseline.current = null
        pairCancel()
      }
    }
    const target = expected.current
    if (target && remote.bind === target.bind && remote.public_url?.replace(/\/$/, '') === target.public_url && remote.enabled && remote.listening) {
      expected.current = null
      setPending(false)
      setView('scan')
    }
    if (!confirmed && view === 'scan' && live && !requested.current) {
      requested.current = true
      baseline.current = new Set(remote.devices.map((device) => device.id))
      pairStart()
    }
  }, [remote, view, live, confirmed, pairStart, pairCancel])

  useEffect(() => {
    if (!pairing) return
    setIssued(pairing)
    setNow(Date.now())
    // One second matches the displayed countdown; no terminal rendering is involved.
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])

  useEffect(() => {
    if (remote && !remote.enabled && view === 'scan') {
      baseline.current = null
      requested.current = false
      setIssued(null)
      setView('route')
    }
  }, [remote, view])

  useEffect(() => {
    if (error || remote?.error || !remote?.enabled) setPending(false)
  }, [error, remote?.error, remote?.enabled])

  useEffect(() => {
    if (!view) return
    if (view === 'route' && !confirmed) root.current?.querySelector<HTMLInputElement>('#connect-phone-address')?.focus()
    else dismiss.current?.focus()
  }, [view, confirmed])

  const resetPairing = (): void => {
    pairCancel()
    baseline.current = null
    requested.current = false
    expected.current = null
    setPending(false)
    setIssued(null)
  }
  const submit = (): void => {
    if (!settings || !remote || pending || !client) return
    resetPairing()
    if (live) {
      setView('scan')
      return
    }
    expected.current = settings
    setPending(true)
    configure({ ...settings, ...(!remote.enabled ? { enabled: true } : {}) })
  }
  const retry = (): void => {
    setIssued(null)
    requested.current = true
    baseline.current = new Set(remote?.devices.map((device) => device.id))
    pairStart()
  }
  const copyText = (target: 'command' | 'link', text: string): void => {
    setCopyTarget(target)
    copy(text)
  }
  const heading = headingOf(confirmed, view)
  const copyProps = { copyState, copyTarget, copyText }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    if (event.key === 'Enter' && view === 'route' && event.target instanceof HTMLInputElement && !event.target.readOnly) {
      event.preventDefault()
      if (!event.nativeEvent.isComposing) submit()
    }
    if (event.key === 'Tab') {
      event.stopPropagation()
      trapFocus(event)
    }
  }
  let body: React.JSX.Element
  if (confirmed) body = <ConnectedStep heading={heading} />
  else if (!remote || !view) body = <Inline gap="small"><Spinner label="Loading" /><Text size="small" tone="muted">Asking the daemon for its remote access settings…</Text></Inline>
  else if (view === 'route') body = <RouteStep route={route} port={port} url={url} fieldError={fieldError} onRoute={(value) => { resetPairing(); setRoute(value); setUrl('') }} onUrl={(value) => { resetPairing(); setUrl(value) }} {...copyProps} />
  else body = <ScanStep shown={shown} expired={expired} countdown={countdownOf(shown?.expiresAt, now)} waiting={!!pairing && !expired} loading={scanLoading(remoteError, pending, live)} fieldError={fieldError} trust={!!remote.tls} fingerprint={remote.ca_fingerprint} {...copyProps} />

  return createPortal(
    <DialogBackdrop onMouseDown={onClose}>
      <DialogPanel size="wide" ref={root} role="dialog" aria-modal="true" aria-labelledby="connect-phone-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        {confirmed ? null : <DialogTitle id="connect-phone-title">{heading}</DialogTitle>}
        <DialogBody variant="stacked">{body}</DialogBody>
        <DialogActions variant="row">
          <ConnectPhoneActions
            confirmed={!!confirmed}
            view={view}
            expired={expired}
            routeSummary={routeSummaryOf(route, remote?.public_url)}
            submitLabel={submitLabelOf(pending, live)}
            canSubmit={[settings, client, remote].every(Boolean) && !pending}
            dismiss={dismiss}
            onClose={onClose}
            onAnother={() => { resetPairing(); setConfirmed(null) }}
            onChangeRoute={() => { resetPairing(); setView('route') }}
            onRetry={retry}
            onSubmit={submit}
          />
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>, document.body
  )
}

export function ConnectPhoneHost({ client }: { client: HoustonClient | null }): React.JSX.Element | null {
  const [open, setOpen] = useState<{ step?: ConnectPhoneStep } | null>(null)
  useEffect(() => {
    const show = (event: Event): void => setOpen((event as CustomEvent<{ step?: ConnectPhoneStep }>).detail ?? {})
    window.addEventListener(CONNECT_PHONE_EVENT, show)
    return () => window.removeEventListener(CONNECT_PHONE_EVENT, show)
  }, [])
  return open ? <ConnectPhoneDialog client={client} initialStep={open.step} onClose={() => setOpen(null)} /> : null
}
