import React from 'react'
import { AddPanePopover } from '../src/components/AddPanePopover'
import { AttachmentChip } from '../src/components/AttachmentChip'
import { ComposerControls, type ComposerChip } from '../src/components/ComposerControls'
import { NewSessionComposer } from '../src/components/NewSessionComposer'
import { ReconnectBanner } from '../src/components/ReconnectBanner'
import type { HoustonClient } from '../src/houston/client'
import type { AgentProfileState } from '../src/components/SettingsView'

const noop = (): void => {}

function chip(id: string, label: string, options: string[], over: Partial<ComposerChip> = {}): ComposerChip {
  return {
    id,
    label,
    value: options[0],
    options: options.map((value) => ({ value, label: value })),
    onChange: noop,
    ...over
  }
}

const CHIPS: ComposerChip[] = [
  chip('model', 'Model · Opus', ['Opus', 'Sonnet', 'Haiku']),
  chip('effort', 'Effort · High', ['Low', 'Medium', 'High']),
  chip('mode', 'Mode · Plan', ['Plan', 'Edit'])
]

function Stage({ children, height = 260 }: { children: React.ReactNode; height?: number }): React.JSX.Element {
  return <div style={{ padding: 24, height, background: 'var(--content-bg)', boxSizing: 'border-box', width: 520 }}>{children}</div>
}

function useClickAfterMount(selector: string): React.RefObject<HTMLDivElement | null> {
  const ref = React.useRef<HTMLDivElement>(null)
  const clicked = React.useRef(false)
  React.useEffect(() => {
    // Strict mode runs effects twice; a toggle must be clicked once.
    if (clicked.current) return
    clicked.current = true
    ref.current?.querySelector<HTMLElement>(selector)?.click()
  }, [selector])
  return ref
}

export function ComposerControlsOpen(): React.JSX.Element {
  const ref = useClickAfterMount('[data-testid="composer-chip"]')
  return (
    <div ref={ref}>
      <Stage>
        <ComposerControls chips={CHIPS} onSend={noop} />
      </Stage>
    </div>
  )
}

export function ComposerControlsOverflow(): React.JSX.Element {
  const ref = useClickAfterMount('[data-testid="composer-chip-overflow"]')
  const chips = [...CHIPS, chip('branch', 'Branch · main', ['main', 'dev']), chip('sandbox', 'Sandbox · On', ['On', 'Off'])]
  return (
    <div ref={ref}>
      <Stage>
        <ComposerControls chips={chips} onSend={noop} />
      </Stage>
    </div>
  )
}

export function ComposerControlsStates(): React.JSX.Element {
  const disabled = [chip('model', 'Model · Opus', ['Opus'], { disabled: true, disabledReason: 'Locked' }), CHIPS[1]]
  return (
    <>
      <style>{'.composer-controls-states [role="status"] { animation: none !important; }'}</style>
      <Stage height={260}>
        <div className="composer-controls-states" style={{ display: 'grid', gap: 16 }}>
          <ComposerControls chips={CHIPS} onSend={noop} />
          <ComposerControls chips={disabled} onSend={noop} sendDisabled />
          <ComposerControls chips={CHIPS.slice(0, 2)} onSend={noop} loading sendLabel="Build" />
        </div>
      </Stage>
    </>
  )
}

const PIXEL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#c0663a"/><circle cx="20" cy="15" r="9" fill="#f4d9a8"/></svg>')

export function AttachmentChips(): React.JSX.Element {
  return (
    <Stage height={220}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxWidth: 440 }}>
        <AttachmentChip filename="notes.md" extension="md" />
        <AttachmentChip filename="report.pdf" extension="pdf" onRemove={noop} />
        <AttachmentChip filename="archive.tar.gz" extension="gz" onClick={noop} onRemove={noop} />
        <AttachmentChip filename="shot.png" extension="png" imageUrl={PIXEL} onRemove={noop} />
        <AttachmentChip filename="a-very-long-filename-that-must-truncate-inside-the-chip-width.markdown" extension="markdown" />
      </div>
    </Stage>
  )
}

export function AttachmentPreviews(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>('[data-testid="attachment-chip"]').forEach((el) => {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
  }, [])
  return (
    <div ref={ref}>
      <Stage height={260}>
        <div style={{ display: 'flex', gap: 120 }}>
          <AttachmentChip filename="notes.md" extension="md" />
          <AttachmentChip filename="shot.png" extension="png" imageUrl={PIXEL} />
        </div>
      </Stage>
    </div>
  )
}

const FROZEN_NOW = 1_700_000_000_000

export function ReconnectBannerStory({ error }: { error: string | null }): React.JSX.Element {
  // The age readout ticks from Date.now(); freezing it keeps the capture stable.
  Date.now = () => FROZEN_NOW
  return (
    <div className="reconnect-banner-story" style={{ height: '100%', background: 'var(--content-bg)' }}>
      <style>{'.reconnect-banner-story [role="status"] > span:first-child { animation: none !important; opacity: 0.25; }'}</style>
      <ReconnectBanner since={FROZEN_NOW - 12_000} error={error} onRetry={noop} />
    </div>
  )
}

const ROUTES_CLIENT = {
  subscribe: (_kind: string, cb: (message: { workspace: string; routes: unknown[] }) => void) => {
    cb({
      workspace: '~/Desktop/acme',
      routes: [
        { pattern: 'src/**/*.rs', model: 'opus', effort: 'high' },
        { pattern: 'docs/**', model: 'haiku', effort: null }
      ]
    })
    return noop
  },
  workspaceRoutingGet: noop
} as unknown as HoustonClient

export function NewSessionWithRoutes(): React.JSX.Element {
  return (
    <NewSessionComposer
      workspaceName="acme"
      workspacePath="~/Desktop/acme"
      gridName="Improve Orchestration"
      client={ROUTES_CLIENT}
      onLaunch={noop}
      onCancel={noop}
    />
  )
}

export function NewSessionTask({ text, focus }: { text: string; focus: boolean }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const area = ref.current?.querySelector<HTMLTextAreaElement>('textarea')
    if (!area) return
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
    if (focus) area.focus()
    // Step the counter up once so the disabled-at-minimum state also renders.
    ref.current?.querySelector<HTMLElement>('[aria-label="Fewer"]')?.click()
  }, [text, focus])
  return (
    <div ref={ref} style={{ display: 'flex', height: '100%' }}>
      <NewSessionComposer workspaceName="acme" workspacePath="~/Desktop/acme" gridName="Improve Orchestration" onLaunch={noop} onCancel={noop} />
    </div>
  )
}

const PROFILES: AgentProfileState = {
  profiles: [
    { id: 1, agent: 'claude', name: 'Work account', config_dir: '~/.claude-work' },
    { id: 2, agent: 'claude', name: 'Personal account', config_dir: '~/.claude-personal' }
  ],
  active: []
}

export function AddPaneProfiles(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    rows.find((button) => button.textContent?.trim().toLowerCase() === 'claude')?.click()
  }, [])
  return (
    <div ref={ref} style={{ height: '100%' }}>
      <AddPanePopover right={24} y={24} hasWorkspace keymapOverrides={{ bindings: {}, shortcuts_enabled: true }} onClose={noop} onNewTerminal={noop} onNewBrowser={noop} onSpawnAgent={noop} onSplitDown={noop} onNewGrid={noop} agentProfiles={PROFILES} />
    </div>
  )
}

export function AddPaneDisabled(): React.JSX.Element {
  return <AddPanePopover right={24} y={24} hasWorkspace={false} keymapOverrides={{ bindings: {}, shortcuts_enabled: true }} onClose={noop} onNewTerminal={noop} onNewBrowser={noop} onSpawnAgent={noop} onNewGrid={noop} agentProfiles={null} />
}
