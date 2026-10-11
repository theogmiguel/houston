import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient, RemoteConfigurePatch } from './client'
import type { RemoteInfo } from './generated/RemoteInfo'

export interface RemotePairing {
  url: string
  qrSvg: string
  expiresAt: number
}

export interface UseRemote {
  remote: RemoteInfo | null
  pairing: RemotePairing | null
  error: string | null
  configure: (patch: RemoteConfigurePatch) => void
  pairStart: () => void
  pairCancel: () => void
  revoke: (id: number) => void
}

/// Settings ▸ Remote access state. The daemon's `remote_state` drives every
/// read; a refusal arrives as an `error` with context "remote".
export function useRemote(client: HoustonClient | null): UseRemote {
  const [remote, setRemote] = useState<RemoteInfo | null>(null)
  const [pairing, setPairing] = useState<RemotePairing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const devicesAtPairing = useRef<number | null>(null)

  useEffect(() => {
    setRemote(null)
    setPairing(null)
    setError(null)
    if (!client) return
    const offState = client.subscribe('remote_state', (msg) => {
      setRemote(msg.remote)
      const before = devicesAtPairing.current
      if (before !== null && msg.remote.devices.length > before) {
        devicesAtPairing.current = null
        setPairing(null)
      }
    })
    const offPairing = client.subscribe('remote_pairing', (msg) => {
      setPairing({ url: msg.url, qrSvg: msg.qr_svg, expiresAt: msg.expires_at })
    })
    const offError = client.subscribe('error', (msg) => {
      if (msg.context === 'remote') setError(msg.message)
    })
    client.remoteGet()
    return () => {
      offState()
      offPairing()
      offError()
    }
  }, [client])

  useEffect(() => {
    if (!pairing) return
    const left = pairing.expiresAt - Date.now()
    const id = setTimeout(() => setPairing(null), Math.max(0, left))
    return () => clearTimeout(id)
  }, [pairing])

  const configure = useCallback(
    (patch: RemoteConfigurePatch) => {
      setError(null)
      client?.remoteConfigure(patch)
    },
    [client]
  )

  const pairStart = useCallback(() => {
    setError(null)
    devicesAtPairing.current = remote?.devices.length ?? 0
    client?.remotePairStart()
  }, [client, remote])

  const pairCancel = useCallback(() => {
    devicesAtPairing.current = null
    setPairing(null)
  }, [])

  const revoke = useCallback(
    (id: number) => {
      setError(null)
      client?.remoteDeviceRevoke(id)
    },
    [client]
  )

  return { remote, pairing, error, configure, pairStart, pairCancel, revoke }
}

/// True when a device's token and the pane text it reads would cross the
/// network without TLS: the bind is off loopback and no https URL fronts it.
export function plainHttpOffLoopback(remote: Pick<RemoteInfo, 'bind' | 'public_url'>): boolean {
  const host = remote.bind.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const loopback = host === '::1' || host.startsWith('127.')
  return !loopback && !(remote.public_url ?? '').startsWith('https://')
}
