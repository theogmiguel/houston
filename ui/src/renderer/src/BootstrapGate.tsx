import React from 'react'
import { BTN_GHOST, BTN_PRIMARY } from './components/buttonChrome'
import { isTauri } from './houston/host'
import { startDragging } from './houston/bridge'
import { MATERIAL_CLS, materialAttrs } from './components/material'

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
  return (
    <div
      className="h-screen grid overflow-hidden"
      style={{
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        gridTemplateRows: 'var(--h-top) 1fr',
        gridTemplateAreas: '"rail topbar" "rail grid"'
      }}
    >
      <aside
        {...materialAttrs('shell')}
        className={`[grid-area:rail] w-60 flex-none flex flex-col relative z-[var(--z-leaf)] ${MATERIAL_CLS.shell} border-r border-[var(--divider)]`}
      >
        <div
          className="h-[var(--h-railhead)] flex-none flex items-center gap-[var(--space-2-5)] px-[var(--space-3)] [-webkit-app-region:drag] select-none"
          onMouseDown={onDragStripMouseDown}
        >
          <div className="boot-spinner" />
        </div>
      </aside>
      <div
        {...materialAttrs('shell')}
        className={`[grid-area:topbar] h-[var(--h-top)] [-webkit-app-region:drag] select-none ${MATERIAL_CLS.shell}`}
        onMouseDown={onDragStripMouseDown}
      />
      <main className="[grid-area:grid] min-w-0 min-h-0 relative overflow-hidden">
        <div
          {...materialAttrs('raised')}
          className={`absolute inset-[var(--pane-gutter)] rounded-[var(--tr-radius-md)] ${MATERIAL_CLS.raised}`}
        />
      </main>
    </div>
  )
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
    <div className="h-screen w-screen flex flex-col">
      <div
        className="h-[var(--h-titlebar)] w-full flex-none [-webkit-app-region:drag]"
        onMouseDown={onDragStripMouseDown}
      />
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="flex flex-col items-center gap-3 max-w-[480px] text-center">
          <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-muted)]">
            Bridge Not Ready
          </span>
          <h1 className="[font-size:var(--tr-text-heading-size)] [font-weight:var(--tr-text-heading-weight)] [letter-spacing:var(--tr-text-heading-tracking)] text-[var(--text-primary)] m-0">
            Houston failed to start
          </h1>
          <p className="[font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] text-[var(--text-muted)] m-0">
            {message}
          </p>
          <div className="flex gap-2 mt-2">
            <button className={`btn ${BTN_GHOST}`} onClick={onRetry}>
              Retry
            </button>
            <button className={`btn ${BTN_PRIMARY}`} onClick={onReload}>
              Reload App
            </button>
          </div>
        </div>
      </div>
    </div>
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
