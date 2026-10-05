// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeymapOverrides } from '../houston/client'
import { AddPanePopover } from './AddPanePopover'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEYMAP: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
})

const noop = (): void => {}

function mount(overrides: Partial<Parameters<typeof AddPanePopover>[0]> = {}): HTMLElement {
  root = createRoot(container!)
  act(() => {
    root!.render(
      <AddPanePopover
        right={0}
        y={0}
        hasWorkspace
        keymapOverrides={KEYMAP}
        onClose={noop}
        onNewTerminal={noop}
        onSpawnAgent={noop}
        onNewGrid={noop}
        agentProfiles={null}
        {...overrides}
      />
    )
  })
  return container!
}

describe('AddPanePopover (step 13, reference shape)', () => {
  it('lists Terminal but no Files, Browser or New session rows: those open from the side panel and the workspace row', () => {
    const el = mount()
    const rows = Array.from(el.querySelectorAll('button'))
    expect(rows[0]?.textContent).toContain('Terminal')
    expect(el.textContent).toContain('t')
    expect(el.querySelector('[data-pane-kind]')).toBeNull()
    expect(el.querySelector('[data-testid="add-pane-new-session"]')).toBeNull()
    expect(rows[rows.length - 1]?.textContent).toContain('New tab')
  })

  it('lists the real agent CLIs Houston can spawn, every one brand-tinted', () => {
    const el = mount()
    const buttons = Array.from(el.querySelectorAll('button'))
    for (const agent of ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok']) {
      expect(el.textContent).toContain(agent)
      const row = buttons.find((b) => b.textContent?.includes(agent))
      expect(
        row?.querySelector('span[style]')?.getAttribute('style'),
        `${agent} row tint`
      ).toContain(`var(--${agent})`)
    }
  })

  it('disables every workspace-gated row when no workspace is open, without hiding them', () => {
    const el = mount({ hasWorkspace: false })
    const buttons = Array.from(el.querySelectorAll('button'))
    const claude = buttons.find((b) => b.textContent?.includes('claude')) as HTMLButtonElement
    expect(claude.disabled).toBe(true)
  })

  it('lists the current workspace actions in the new pane menu', () => {
    const el = mount({ workspaceActions: [{ id: 'test', name: 'test', command: 'bun run test', shortcut: null }] })
    expect(el.textContent).toContain('ACTIONS')
    expect(el.textContent).toContain('▶ test')
    expect(el.textContent).toContain('＋ Add action')
  })

  it('draws a distinct bespoke SVG mark for every agent row, not a shared fallback', () => {
    const el = mount()
    const buttons = Array.from(el.querySelectorAll('button'))
    const paths = new Set<string>()
    for (const agent of ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok']) {
      const btn = buttons.find((b) => b.textContent?.includes(agent))!
      const svg = btn.querySelector('svg')
      expect(svg, agent).not.toBeNull()
      const shape = svg!.innerHTML
      expect(shape.length, `${agent} glyph is empty`).toBeGreaterThan(0)
      expect(paths.has(shape), `${agent} glyph duplicates another agent's`).toBe(false)
      paths.add(shape)
    }
  })

  it('gives Split down and New tab an icon, not bare indented text', () => {
    const el = mount()
    const buttons = Array.from(el.querySelectorAll('button'))
    const splitDown = buttons.find((b) => b.textContent?.includes('Split down'))!
    const newGrid = buttons.find((b) => b.textContent?.includes('New tab'))!
    expect(splitDown.querySelector('svg')).not.toBeNull()
    expect(newGrid.querySelector('svg')).not.toBeNull()
  })

  it('disables Split down when no pane is anchored, rather than hiding it', () => {
    const el = mount({ onSplitDown: undefined })
    const buttons = Array.from(el.querySelectorAll('button'))
    const splitDown = buttons.find((b) => b.textContent?.includes('Split down')) as HTMLButtonElement
    expect(splitDown.disabled).toBe(true)
  })

  it('keeps every tooltip-wrapped row full width', () => {
    const el = mount({ hasWorkspace: false, onSplitDown: undefined })
    const rows = Array.from(el.querySelectorAll('button'))
    const labels = ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok', 'Split down', 'New tab']

    for (const label of labels) {
      const row = rows.find((button) => button.textContent?.includes(label))
      expect(row, `${label} row`).not.toBeUndefined()
      expect(row?.classList.contains('w-full'), `${label} row width`).toBe(true)
    }
  })

  it('closes and dispatches on a Terminal click', () => {
    const onClose = vi.fn()
    const onNewTerminal = vi.fn()
    const el = mount({ onClose, onNewTerminal })
    const terminalBtn = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Terminal')
    )!
    act(() => terminalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onNewTerminal).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes and dispatches the chosen agent on a CLI row click', () => {
    const onSpawnAgent = vi.fn()
    const el = mount({ onSpawnAgent })
    const codexBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('codex'))!
    act(() => codexBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSpawnAgent).toHaveBeenCalledWith('codex')
  })

  const TWO_CLAUDE_PROFILES = {
    profiles: [
      { id: 1, agent: 'claude' as const, name: 'work', config_dir: '/tmp/work' },
      { id: 2, agent: 'claude' as const, name: 'personal', config_dir: '/tmp/personal' }
    ],
    active: []
  }

  it('keeps the single-button shape only at ZERO saved profiles (threshold fixed 2026-08-25)', () => {
    const onSpawnAgent = vi.fn()
    const none = { ...TWO_CLAUDE_PROFILES, profiles: [] }
    const el = mount({ onSpawnAgent, agentProfiles: none })
    const claudeBtn = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('claude')
    )!
    expect(claudeBtn.querySelector('svg[class*="rotate"]')).toBeNull()
    act(() => claudeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSpawnAgent).toHaveBeenCalledWith('claude')
  })

  it('splits the claude row with a SINGLE saved profile', () => {
    const onSpawnAgent = vi.fn()
    const oneProfile = { ...TWO_CLAUDE_PROFILES, profiles: TWO_CLAUDE_PROFILES.profiles.slice(0, 1) }
    const el = mount({ onSpawnAgent, agentProfiles: oneProfile })
    const claudeBtn = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('claude') && !b.textContent?.includes('codex')
    )!
    act(() => claudeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSpawnAgent).not.toHaveBeenCalled()
    expect(el.textContent).toContain('Default account')
    expect(el.textContent).toContain(TWO_CLAUDE_PROFILES.profiles[0].name)
  })

  it('splits the claude row into Default account + each saved profile at 2+ profiles', () => {
    const onSpawnAgent = vi.fn()
    const el = mount({ onSpawnAgent, agentProfiles: TWO_CLAUDE_PROFILES })
    const claudeBtn = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('claude') && !b.textContent?.includes('codex')
    )!
    act(() => claudeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSpawnAgent).not.toHaveBeenCalled()
    expect(el.textContent).toContain('Default account')
    expect(el.textContent).toContain('work')
    expect(el.textContent).toContain('personal')

    const defaultRow = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Default account')
    )!
    act(() => defaultRow.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSpawnAgent).toHaveBeenCalledWith('claude', { kind: 'default' })

    const workRow = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'work')!
    act(() => workRow.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSpawnAgent).toHaveBeenCalledWith('claude', { kind: 'profile', id: 1 })
  })

  it('never splits codex off claude having profiles — each agent is independent', () => {
    const onSpawnAgent = vi.fn()
    const el = mount({ onSpawnAgent, agentProfiles: TWO_CLAUDE_PROFILES })
    const codexBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('codex'))!
    expect(codexBtn.querySelector('svg[class*="rotate"]')).toBeNull()
    act(() => codexBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSpawnAgent).toHaveBeenCalledWith('codex')
  })
})
