import React from 'react'
import { isTauri } from './houston/host'
import { startDragging } from './houston/bridge'
import { Button, StartupFailure, StartupSkeleton } from './components/ui'

const BRIDGE_LOAD_TIMEOUT_MS = 15_000

async function loadBridge(): Promise<void> {
  await import('@tauri-apps/api/core')
}

function onDragStripMouseDown(e: React.MouseEvent<HTMLElement>): void {
  if (e.button !== 0) return
  void startDragging().catch((err: unknown) => {
    console.warn('houston: startDragging failed', err)
  })
}

function failureMessage(error: Error | null, timedOut: boolean): string {
  if (error) return `Could not initialize the desktop bridge: ${error.message}`
  if (timedOut) {
    const seconds = Math.round(BRIDGE_LOAD_TIMEOUT_MS / 1000)
    return `The desktop bridge is taking longer than ${seconds}s to load. The renderer may be wedged after a sleep/wake cycle.`
  }
  return ''
}

function LoadingFallback(): React.JSX.Element {
  return <StartupSkeleton onDragMouseDown={onDragStripMouseDown} />
}

function FailureScreen({
  message,
  onRetry,
  onReload
}: {
  message: string
  onRetry: () => void
  onReload: () => void
}): React.JSX.Element {
  return (
    <StartupFailure
      eyebrow="Bridge not ready"
      title="Houston failed to start"
      message={message}
      onDragMouseDown={onDragStripMouseDown}
    >
      <Button variant="legacy-ghost" onClick={onRetry}>
        Retry
      </Button>
      <Button variant="legacy-primary" onClick={onReload}>
        Reload app
      </Button>
    </StartupFailure>
  )
}

interface BootstrapGateProps {
  children: React.ReactNode
  load?: () => Promise<void>
}

export function BootstrapGate({
  children,
  load = loadBridge
}: BootstrapGateProps): React.JSX.Element {
  const tauri = React.useMemo(() => isTauri(), [])
  const [ready, setReady] = React.useState(!tauri)
  const [error, setError] = React.useState<Error | null>(null)
  const [timedOut, setTimedOut] = React.useState(false)
  const [retryKey, setRetryKey] = React.useState(0)

  React.useEffect(() => {
    if (!tauri) return
    let cancelled = false
    setError(null)
    setTimedOut(false)

    const timer = setTimeout(() => {
      if (!cancelled) setTimedOut(true)
    }, BRIDGE_LOAD_TIMEOUT_MS)

    load()
      .then(() => {
        if (cancelled) return
        clearTimeout(timer)
        setReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        clearTimeout(timer)
        const asError = err instanceof Error ? err : new Error(String(err))
        console.error('BootstrapGate: bridge module failed to load', asError)
        setError(asError)
      })

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey])

  if (ready) return <>{children}</>

  if (error || timedOut) {
    return (
      <FailureScreen
        message={failureMessage(error, timedOut)}
        onRetry={() => setRetryKey((k) => k + 1)}
        onReload={() => {
          try {
            window.location.reload()
          } catch (err) {
            console.error('BootstrapGate: window.location.reload() failed', err)
          }
        }}
      />
    )
  }

  return <LoadingFallback />
}
