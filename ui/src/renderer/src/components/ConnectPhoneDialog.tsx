import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNativeOverlaySuppression } from '../layout/nativeSuppression'
import { CONNECT_PHONE_EVENT } from '../connectPhone'
import type { HoustonClient } from '../houston/client'
import { useRemote } from '../houston/useRemote'
import { Button, Caption, DialogActions, DialogBackdrop, DialogBody, DialogDescription, DialogPanel, DialogTitle, Field, Notice, QrImage, Select, TextInput } from './ui'
import { Text } from './ui/Text'
import { PairingProgress } from './ui/PairingProgress'
import { useCopyFeedback } from './useCopyFeedback'

type Route = 'tailscale' | 'wifi'
const ROUTES = [
  { value: 'tailscale', label: 'Tailscale (works anywhere, HTTPS)' },
  { value: 'wifi', label: 'Same Wi-Fi (plain HTTP)' }
]
const SECURITY = 'A paired device can read any pane and type into it, which is as much access as a shell on this computer.'
const HTTP_WARNING = 'Devices reach this address over plain HTTP, so their token and the pane text they read cross the network unencrypted. Use tailscale serve and an https public URL.'

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

export function ConnectPhoneDialog({ client, onClose }: { client: HoustonClient | null; onClose: () => void }): React.JSX.Element {
  const { remote, pairing, error, configure, pairStart, pairCancel } = useRemote(client)
  const [route, setRoute] = useState<Route>('tailscale')
  const [url, setUrl] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [pending, setPending] = useState(false)
  const [codeState, setCodeState] = useState<'idle' | 'creating' | 'issued'>('idle')
  const expected = useRef<{ bind: string; public_url: string } | null>(null)
  const baseline = useRef<Set<number> | null>(null)
  const requested = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  useNativeOverlaySuppression('modal', true, root)
  const { copy, copyState } = useCopyFeedback()
  const port = remote?.bind.match(/:(\d+)$/)?.[1] ?? ''
  const settings = routeSettings(route, port, url)
  const urlError = url !== '' && !settings
    ? `Connection URL ${JSON.stringify(url)} must be ${route === 'tailscale' ? 'an HTTPS origin without credentials, a path, query, or fragment.' : `a reachable HTTP origin at port ${port}, without credentials, a path, query, or fragment.`}`
    : undefined
  const applied = !!remote && !!settings && remote.bind === settings.bind && remote.public_url?.replace(/\/$/, '') === settings.public_url

  useEffect(() => {
    const trigger = document.activeElement
    close.current?.focus()
    return () => {
      pairCancel()
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
  }, [pairCancel])

  useEffect(() => {
    if (!remote || initialized) return
    setRoute(remote.public_url?.startsWith('http:') ? 'wifi' : 'tailscale')
    setUrl(remote.public_url ?? '')
    setInitialized(true)
  }, [remote, initialized])

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
    }
    if (!confirmed && initialized && applied && remote.enabled && remote.listening && !requested.current) {
      requested.current = true
      baseline.current = new Set(remote.devices.map((device) => device.id))
      setCodeState('creating')
      pairStart()
    }
  }, [remote, initialized, applied, confirmed, pairStart, pairCancel])

  useEffect(() => {
    if (!pairing) return
    setCodeState('issued')
    setNow(Date.now())
    // One second matches the displayed countdown; no terminal rendering is involved.
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])

  useEffect(() => {
    if (error || remote?.error || !remote?.enabled) setPending(false)
  }, [error, remote?.error, remote?.enabled])

  useEffect(() => {
    if (confirmed) close.current?.focus()
  }, [confirmed])

  const resetPairing = (): void => {
    pairCancel()
    baseline.current = null
    requested.current = false
    expected.current = null
    setPending(false)
    setCodeState('idle')
  }
  const apply = (): void => {
    if (!settings || !remote) return
    resetPairing()
    expected.current = settings
    setPending(true)
    configure({ ...settings, ...(!remote.enabled ? { enabled: true } : {}) })
  }
  const retry = (): void => {
    setCodeState('creating')
    requested.current = true
    baseline.current = new Set(remote?.devices.map((device) => device.id))
    pairStart()
  }
  const seconds = Math.max(0, Math.ceil(((pairing?.expiresAt ?? now) - now) / 1000))
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return createPortal(
    <DialogBackdrop onMouseDown={onClose}>
      <DialogPanel size="handoff" ref={root} role="dialog" aria-modal="true" aria-labelledby="connect-phone-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose() }
        if (event.key === 'Tab') {
          event.stopPropagation()
          const controls = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
        <DialogTitle id="connect-phone-title">{confirmed ? `${confirmed} is connected` : 'Connect phone'}</DialogTitle>
        <DialogBody variant="bounded">
          {confirmed ? <>
            <DialogDescription>It can follow and answer every pane. Manage it in Settings ▸ Remote access.</DialogDescription>
            <PairingProgress listening waiting={false} confirmed />
          </> : <>
            <DialogDescription>Follow and answer your panes when you are away from this computer.</DialogDescription>
            <Notice tone="warn">{SECURITY}</Notice>
            {!remote ? <Notice tone="info">Asking the daemon for its remote access settings.</Notice> : <div className="flex flex-wrap items-start gap-[var(--space-5)]">
              <div className="grid gap-[var(--space-2)]">
                {pairing && applied && remote.enabled && remote.listening ? <>
                  <QrImage svg={pairing.qrSvg} label="Pairing code" />
                  <Caption>Single use · expires in {countdown}</Caption>
                  <Button size="sm" onClick={() => copy(pairing.url)}>Copy link</Button>
                  <TextInput aria-label="Pairing link" readOnly value={pairing.url} width="wide" onFocus={(event) => event.currentTarget.select()} />
                </> : <Notice tone="info">{pending ? 'Starting remote access…' : codeState === 'creating' && !error ? 'Creating a single-use code…' : codeState === 'issued' ? 'Code expired or unavailable. Get a new code.' : 'Choose a route and turn on remote access to get a code.'}</Notice>}
              </div>
              <div className="grid flex-1 gap-[var(--space-3)]">
                <Field label="How will the phone reach this computer?">
                  <Select aria-label="Connection route" value={route} options={ROUTES} onChange={(value) => { resetPairing(); setRoute(value as Route); setUrl('') }} />
                </Field>
                {route === 'tailscale' ? <>
                  <DialogDescription>Install Tailscale on both devices. Run this command on the computer, then paste the HTTPS address it prints. Only your tailnet devices can open it.</DialogDescription>
                  <Text size="small" mono breakAll>{`tailscale serve --bg ${port}`}</Text>
                  <Button size="sm" onClick={() => copy(`tailscale serve --bg ${port}`)}>Copy command</Button>
                </> : <>
                  <DialogDescription>Use a trusted home or office network. Houston will listen on all interfaces. Enter this computer’s LAN address and port, such as http://192.168.1.20:{port}.</DialogDescription>
                  <Notice tone="warn">{HTTP_WARNING}</Notice>
                </>}
                <Field label={route === 'tailscale' ? 'HTTPS public URL' : 'LAN public URL'} error={urlError} hint={route === 'tailscale' ? 'An HTTPS origin, such as https://machine.tailnet.ts.net.' : `An HTTP origin reachable by your phone, including port ${port}.`}>
                  <TextInput type="url" aria-label="Connection URL" value={url} width="wide" aria-invalid={url !== '' && !settings} onChange={(event) => { resetPairing(); setUrl(event.target.value) }} />
                </Field>
                <Button variant="primary" disabled={!settings || pending || !client} onClick={apply}>{!remote.enabled ? 'Enable remote access' : 'Apply route'}</Button>
                {applied && remote.enabled && remote.listening && !pairing && <Button onClick={retry}>Get a new code</Button>}
                <PairingProgress listening={remote.enabled && remote.listening} waiting={!!pairing && applied} />
              </div>
            </div>}
          </>}
          {(error || remote?.error) && <Notice tone="danger">{error ?? remote?.error}</Notice>}
          {copyState !== 'idle' && <Notice tone={copyState === 'error' ? 'warn' : 'info'}>{copyState === 'error' ? 'Could not copy. Select and copy the text above.' : 'Copied.'}</Notice>}
        </DialogBody>
        <DialogActions variant="row">
          {confirmed && <Button onClick={() => { resetPairing(); setConfirmed(null) }}>Connect another</Button>}
          <Button ref={close} variant={confirmed ? 'primary' : 'ghost'} onClick={onClose}>{confirmed ? 'Done' : 'Close'}</Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>, document.body
  )
}

export function ConnectPhoneHost({ client }: { client: HoustonClient | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = (): void => setOpen(true)
    window.addEventListener(CONNECT_PHONE_EVENT, show)
    return () => window.removeEventListener(CONNECT_PHONE_EVENT, show)
  }, [])
  return open ? <ConnectPhoneDialog client={client} onClose={() => setOpen(false)} /> : null
}
