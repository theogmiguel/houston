import React from 'react'
import { BootstrapGate } from '../src/BootstrapGate'
import { FirstRun } from '../src/components/FirstRun'
import { HostKeyModal } from '../src/components/HostKeyModal'
import { ShortcutSheet } from '../src/components/ShortcutSheet'
import { SshConnectModal } from '../src/components/SshConnectModal'
import { UpdateInstallModal } from '../src/components/UpdateInstallModal'
import { KeymapOverridesContext } from '../src/layout/keymapOverridesContext'
import { setUpdateInstallForTests, type UpdateInstallState } from '../src/updateInstall'

const noop = (): void => {}

function useClicks(selectors: string[], ref: React.RefObject<HTMLElement | null>): void {
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const selector of selectors) ref.current?.querySelector<HTMLElement>(selector)?.click()
    }, 50)
    return () => window.clearTimeout(timer)
  }, [selectors, ref])
}

interface DaemonFixture {
  ids: number[]
  supported: boolean
  reason?: string
}

function UpdateScene({ daemon, install, clicks = [], notes }: { daemon: DaemonFixture; install?: UpdateInstallState; clicks?: string[]; notes?: string }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const [ready, setReady] = React.useState(false)
  React.useLayoutEffect(() => {
    const win = window as unknown as { houston?: unknown }
    const realFetch = window.fetch
    const realHouston = win.houston
    win.houston = { getConfig: async () => ({ port: 1, token: 'story' }) }
    window.fetch = (async () => new Response(JSON.stringify({
      manage_version: 1, protocol_version: 1, build: 'story', pid: 1, started_at: '', routines_enabled: 0, clients_connected: 1,
      live_sessions: { count: daemon.ids.length, ids: daemon.ids },
      handoff: { supported: daemon.supported, reason: daemon.reason ?? '' },
      reap: { armed: false, deadline_ms: null }
    }), { status: 200 })) as typeof window.fetch
    setUpdateInstallForTests(install ?? { kind: 'idle' })
    setReady(true)
    return () => {
      window.fetch = realFetch
      win.houston = realHouston
      setUpdateInstallForTests({ kind: 'idle' })
    }
  }, [daemon, install])
  useClicks(clicks, ref)
  return (
    <div ref={ref}>
      {ready && (
        <UpdateInstallModal
          release={{ version: '0.14.2', notes: notes ?? 'Bug fixes and improvements.', notes_url: 'https://example.test/release' }}
          currentVersion="0.14.1"
          sessions={daemon.ids.map((id) => ({ id, title: id === 1 ? 'Review API changes' : '', codename: 'Rail', agent: 'claude' }) as never)}
          onClose={noop}
          onLater={noop}
          onOpenExternal={noop}
        />
      )}
    </div>
  )
}

const KEEP: DaemonFixture = { ids: [1, 2], supported: true }
const STOP_CLICK = ['[data-choice="stop"]']

export function UpdateKeepStory(): React.JSX.Element {
  return <UpdateScene daemon={KEEP} notes={'- Faster pane startup\n- Fixes a crash on resume'} />
}
export function UpdateStopStory(): React.JSX.Element {
  return <UpdateScene daemon={KEEP} clicks={STOP_CLICK} />
}
export function UpdateUnsupportedStory(): React.JSX.Element {
  return <UpdateScene daemon={{ ids: [1, 2], supported: false, reason: 'protocol 3 cannot hand off to protocol 4' }} install={{ kind: 'failed', version: '0.14.2', error: 'signature mismatch' }} clicks={['summary']} />
}
export function UpdateEmptyStory(): React.JSX.Element {
  return <UpdateScene daemon={{ ids: [], supported: true }} />
}
export function UpdateRunningStory(): React.JSX.Element {
  return <UpdateScene daemon={KEEP} install={{ kind: 'downloading', downloaded: 4, total: 10 }} />
}
export function UpdateInstallingStory(): React.JSX.Element {
  return <UpdateScene daemon={KEEP} install={{ kind: 'installing' }} />
}

export function HostKeyChangedStory(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  // The accept countdown ticks on a real interval; freezing it keeps the capture deterministic.
  const realInterval = React.useRef(window.setInterval)
  React.useLayoutEffect(() => {
    const saved = realInterval.current
    window.setInterval = (() => 0) as unknown as typeof window.setInterval
    return () => { window.setInterval = saved }
  }, [])
  useClicks(['[data-testid="hostkey-randomart-toggle"]', '[data-testid="hostkey-explainer-toggle"]'], ref)
  return (
    <div ref={ref}>
      <HostKeyModal
        prompt={{ request: 2, host: 'build.example.com', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:0123456789abcdefghijklmnopqrstuvwxyzABCDE', randomart: '+--[ED25519 256]--+\n|      .o..       |\n|     .o+o        |\n+----[SHA256]-----+', changed: true, previous_fingerprint: 'SHA256:ZZZZ9876543210abcdefghijklmnopqrstuvwxyzAB' }}
        onAnswer={noop}
        remaining={2}
        onRejectRemaining={noop}
      />
    </div>
  )
}

export function SshAdvancedStory(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      ref.current?.querySelector<HTMLElement>('[aria-controls="ssh-advanced"]')?.click()
      ref.current?.querySelector<HTMLFormElement>('form')?.requestSubmit()
    }, 50)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div ref={ref}>
      <SshConnectModal initial={{ host: 'bad host', user: 'deploy', port: 22 }} profiles={[]} configHosts={[]} onConnect={noop} onSaveProfile={noop} onDeleteProfile={noop} onClose={noop} />
    </div>
  )
}

export function ShortcutsOffStory(): React.JSX.Element {
  return (
    <KeymapOverridesContext.Provider value={{ bindings: {}, shortcuts_enabled: false }}>
      <ShortcutSheet onClose={noop} />
    </KeymapOverridesContext.Provider>
  )
}

const FIRST_RUN_BASE = {
  workspaces: { onAdd: noop, pending: false, refusals: [], keymapOverrides: { bindings: {}, shortcuts_enabled: true } },
  stateKnown: true,
  caps: { max_live_children: 3, max_spawn_depth: 2 },
  onEnableOrchestration: noop,
  agentHooks: [],
  onAgentHooksSet: noop,
  onDone: noop
}

export function FirstRunOrchestrationStory(): React.JSX.Element {
  return (
    <div className="flex h-full bg-[var(--content-bg)] text-[var(--text-primary)]">
      <FirstRun {...FIRST_RUN_BASE} hasWorkspace orchestrationConsented={false} hooksInstalled />
    </div>
  )
}

export function FirstRunWorkspaceStory(): React.JSX.Element {
  return (
    <div className="flex h-full bg-[var(--content-bg)] text-[var(--text-primary)]">
      <FirstRun {...FIRST_RUN_BASE} hasWorkspace={false} orchestrationConsented hooksInstalled />
    </div>
  )
}

function BootScene({ load }: { load: () => Promise<void> }): React.JSX.Element {
  const [ready, setReady] = React.useState(false)
  React.useLayoutEffect(() => {
    const win = window as unknown as { __TAURI_INTERNALS__?: unknown }
    win.__TAURI_INTERNALS__ = {}
    setReady(true)
    return () => { delete win.__TAURI_INTERNALS__ }
  }, [])
  return ready ? <BootstrapGate load={load}><div /></BootstrapGate> : <div />
}

export function BootLoadingStory(): React.JSX.Element {
  return <BootScene load={() => new Promise<void>(() => {})} />
}

export function BootFailureStory(): React.JSX.Element {
  return <BootScene load={() => Promise.reject(new Error('module not found: tauri.js'))} />
}
