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
  { value: 'wifi', label: 'Same Wi-Fi · plain HTTP' }
]
const ROUTE_HINT: Record<Route, string> = {
  tailscale: 'Works anywhere; only your own devices can open it.',
  wifi: 'Works on a trusted home or office network; Houston listens on all interfaces.'
}
const SECURITY = 'A paired phone can read and type into any pane: as much access as a shell on this computer.'
const HTTP_WARNING = 'Traffic crosses this network unencrypted, including the device token and the pane text it reads.'

export function routeSettings(route: Route, port: string, value: string): { bind: string; public_url: string } | null {
  try {
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    if (route === 'tailscale' && url.protocol !== 'https:') return null
    if (route === 'wifi' && ((url.port || '80') !== port || url.protocol !== 'http:' || ['localhost', '0.0.0.0', '[::]', '[::1]'].includes(url.hostname) || url.hostname.startsWith('127.'))) return null
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
  const port = remote?.bind.match(/:(\d+)$/)?.[1] ?? ''
  const settings = routeSettings(route, port, url)
  const urlError = url !== '' && !settings
    ? `Address ${JSON.stringify(url)} must be ${route === 'tailscale' ? 'an HTTPS origin without credentials, a path, query, or fragment.' : `a reachable HTTP origin at port ${port}, without credentials, a path, query, or fragment.`}`
    : undefined
  const fieldError = urlError ?? error ?? remote?.error ?? undefined
  const applied = !!remote && !!settings && remote.bind === settings.bind && remote.public_url?.replace(/\/$/, '') === settings.public_url
  const live = applied && !!remote?.enabled && !!remote.listening
  const command = `tailscale serve --bg ${port}`
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
    setRoute(remote.public_url?.startsWith('http:') ? 'wifi' : 'tailscale')
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
  const seconds = Math.max(0, Math.ceil(((shown?.expiresAt ?? now) - now) / 1000))
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const routeSummary = `${route === 'tailscale' ? 'Tailscale' : 'Same Wi-Fi'} · ${hostOf(remote?.public_url)} · Change`
  const heading = confirmed ? `${confirmed} is connected` : view === 'scan' ? 'Scan with your phone' : 'Connect a phone'

  return createPortal(
    <DialogBackdrop onMouseDown={onClose}>
      <DialogPanel size="wide" ref={root} role="dialog" aria-modal="true" aria-labelledby="connect-phone-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose() }
        if (event.key === 'Enter' && view === 'route' && event.target instanceof HTMLInputElement && !event.target.readOnly) {
          event.preventDefault()
          if (!event.nativeEvent.isComposing) submit()
        }
        if (event.key === 'Tab') {
          event.stopPropagation()
          trapFocus(event)
        }
      }}>
        {confirmed ? null : <DialogTitle id="connect-phone-title">{heading}</DialogTitle>}
        <DialogBody>
          {confirmed ? (
            <Stack gap={3} align="center">
              <IconTile tone="success" size="lg" radius="medium" icon={<Icon glyph={IconCheck} role="ui" />} />
              <Text as="h2" size="subhead" tone="primary" flush center id="connect-phone-title">{heading}</Text>
              <Text as="p" size="base" tone="secondary" flush center>It can follow and answer every pane. Manage it in Settings ▸ Remote access.</Text>
            </Stack>
          ) : !remote || !view ? (
            <Inline gap="small"><Spinner label="Loading" /><Text size="small" tone="muted">Asking the daemon for its remote access settings…</Text></Inline>
          ) : view === 'route' ? <>
            <DialogDescription>Follow and answer your panes when you are away from this computer.</DialogDescription>
            <FormGrid>
              <FormGridLabel>Route</FormGridLabel>
              <Select aria-label="Route" width="full" value={route} options={ROUTES} onChange={(value) => { resetPairing(); setRoute(value as Route); setUrl('') }} />
              <Text as="p" size="small" tone="muted" flush className="col-start-2">{ROUTE_HINT[route]}</Text>
              {route === 'tailscale' && <>
                <FormGridLabel htmlFor="connect-phone-command">Command</FormGridLabel>
                <Inline gap="small">
                  <TextInput variant="form" id="connect-phone-command" font="mono" readOnly value={command} onFocus={(event) => event.currentTarget.select()} />
                  <Button size="sm" onClick={() => copyText('command', command)}>{copyState === 'success' && copyTarget === 'command' ? 'Copied' : 'Copy'}</Button>
                </Inline>
              </>}
              <FormGridLabel htmlFor="connect-phone-address">Address</FormGridLabel>
              <TextInput variant="form" id="connect-phone-address" type="url" font="mono" value={url} placeholder={route === 'tailscale' ? 'https://machine.tailnet.ts.net' : `http://192.168.1.20:${port}`} autoComplete="off" spellCheck={false} aria-invalid={!!fieldError} aria-describedby="connect-phone-address-note" onChange={(event) => { resetPairing(); setUrl(event.target.value) }} />
              {fieldError
                ? <Text as="p" size="small" tone="danger" flush role="alert" id="connect-phone-address-note" className="col-start-2">{fieldError}</Text>
                : <Text as="p" size="small" tone="muted" flush id="connect-phone-address-note" className="col-start-2">{route === 'tailscale' ? 'Paste the HTTPS address the command prints.' : `The computer's LAN address with port ${port}, as the phone reaches it.`}</Text>}
            </FormGrid>
            {route === 'wifi' && <WarningLine>{HTTP_WARNING}</WarningLine>}
            <WarningLine>{SECURITY}</WarningLine>
            {copyState === 'error' && <Text as="p" size="small" tone="warn" flush role="status">Could not copy. Select the command and copy it manually.</Text>}
          </> : <>
            <DialogDescription>Open the camera and point it at the code.</DialogDescription>
            <Stack gap={2} align="center">
              {shown
                ? <>
                  <QrImage svg={shown.qrSvg} label="Pairing code" dimmed={expired} />
                  <Inline gap="small">
                    <Text size="small" tone="muted">{expired ? 'Code expired' : `Single use · expires in ${countdown} ·`}</Text>
                    {!expired && <Button variant="link" onClick={() => copyText('link', shown.url)}>{copyState === 'success' && copyTarget === 'link' ? 'Copied' : 'Copy link'}</Button>}
                  </Inline>
                  {copyState === 'error' && copyTarget === 'link' && <TextInput aria-label="Pairing link" readOnly value={shown.url} width="full" onFocus={(event) => event.currentTarget.select()} />}
                </>
                : !error && !remote.error && <Inline gap="small"><Spinner label="Loading" /><Text size="small" tone="muted">{pending || !live ? 'Starting remote access…' : 'Creating a single-use code…'}</Text></Inline>}
            </Stack>
            {pairing && !expired && <Inline gap="small" className="justify-center"><Spinner label="Waiting" /><Text size="small" tone="muted">Waiting for the phone to confirm…</Text></Inline>}
            {fieldError && <Text as="p" size="small" tone="danger" flush role="alert">{fieldError}</Text>}
          </>}
        </DialogBody>
        <DialogActions variant="row">
          {confirmed ? <>
            <Button onClick={() => { resetPairing(); setConfirmed(null) }}>Connect another</Button>
            <span className="flex-1" />
            <Button ref={dismiss} variant="primary" onClick={onClose}>Done</Button>
          </> : view === 'scan' ? <>
            <Button variant="ghost" onClick={() => { resetPairing(); setView('route') }}>{routeSummary}</Button>
            <span className="flex-1" />
            <Button ref={dismiss} variant={expired ? 'secondary' : 'primary'} onClick={onClose}>Close</Button>
            {expired && <Button variant="primary" onClick={retry}>Get a new code</Button>}
          </> : <>
            <Button ref={dismiss} variant="secondary" onClick={onClose}>Cancel</Button>
            <span className="flex-1" />
            <Button variant="primary" disabled={!settings || pending || !client || !remote} onClick={submit}>{pending ? 'Turning on…' : live ? 'Show code' : 'Turn on and show code'}</Button>
          </>}
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
