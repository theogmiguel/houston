import { MascotSurfaceMount } from './mascot/MascotMount'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ROOT_CRASH_GUARANTEE, ROOT_CRASH_TITLE } from './components/crashCopy'
import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/500.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/500.css'
import '@fontsource/source-serif-4/600.css'
import { App } from './App'
import { BootstrapGate } from './BootstrapGate'
import { Button, FullScreenMessage } from './components/ui'
import { recordAndReload, reloadStormDetected, resetReloadBudget } from './reloadBudget'
import { installWatchdog } from './watchdog'
import { installNativeFileDrop } from './houston/nativeFileDrop'
import { WindowResizeGrips } from './components/WindowResizeGrips'
import './tailwind.css'
import './components/ui/paneFocus.css'
import './keyframes.css'
import './theme.css'
import './base.css'

class RootBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <FullScreenMessage tone="muted">
        <MascotSurfaceMount mood="hurt" hat="bandage" />
        <p>
          {ROOT_CRASH_TITLE}: {this.state.error.message}
          <br />
          {ROOT_CRASH_GUARANTEE}
        </p>
        <div className="flex gap-[var(--space-2)]">
          <Button variant="legacy-ghost" onClick={recordAndReload}>
            Reload app
          </Button>
        </div>
      </FullScreenMessage>
    )
  }
}

function HardHalt(): React.JSX.Element {
  return (
    <FullScreenMessage tone="danger">
      <p>
        Halted: the app reloaded 3 times in the last 10 minutes without recovering.
        Reloading again won&apos;t help — check that houston-core is running
        (or start the app from a terminal to see the crash), then try again.
      </p>
      <div className="flex gap-[var(--space-2)]">
        <Button
          variant="legacy-primary"
          onClick={() => {
            resetReloadBudget()
            window.location.reload()
          }}
        >
          Try again
        </Button>
      </div>
    </FullScreenMessage>
  )
}

window.addEventListener('error', (e) => {
  console.error('window.onerror:', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandledrejection:', e.reason)
  e.preventDefault()
})

window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

installWatchdog()

void installNativeFileDrop()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <WindowResizeGrips />
    {reloadStormDetected() ? (
      <HardHalt />
    ) : (
      <RootBoundary>
        <BootstrapGate>
          <App />
        </BootstrapGate>
      </RootBoundary>
    )}
  </React.StrictMode>
)
