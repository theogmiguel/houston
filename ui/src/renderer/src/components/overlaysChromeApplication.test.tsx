// @vitest-environment jsdom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeymapOverrides as ClientKeymapOverrides } from '../houston/client'
import type { SshProfile } from '../houston/client'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import type { KeymapOverrides } from '../houston/generated/KeymapOverrides'
import { ConfirmModal } from './ConfirmModal'
import { HostKeyModal, type HostKeyPrompt } from './HostKeyModal'
import { HandoffOverlay, type HandoffUiState } from './HandoffOverlay'
import { ShortcutSheet } from './ShortcutSheet'
import { SaveDiscardModal } from './SaveDiscardModal'
import { SshConnectModal } from './SshConnectModal'
import { AddPanePopover } from './AddPanePopover'

window.houston = { pickFile: vi.fn() } as unknown as Window['houston']

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const SHADOW_2 = 'var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))'

describe('overlays-04: elevation painted on --raised, named shadow', () => {
  it('ConfirmModal panel uses --raised + shadow-2, not --card-bg/--shadow-lg', () => {
    act(() => {
      root.render(<ConfirmModal message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />)
    })
    const panel = container.querySelector('.pop')
    expect(panel?.className).toContain('bg-[var(--raised)]')
    expect(panel?.className).toContain(`shadow-[${SHADOW_2}]`)
    expect(panel?.className).not.toContain('bg-[var(--card-bg)]')
    expect(panel?.className).not.toContain('--shadow-lg')
  })

  it('HostKeyModal panel uses --raised + shadow-2', () => {
    const prompt: HostKeyPrompt = {
      request: 1,
      host: 'example.com',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abcd',
      randomart: '',
      changed: false
    }
    act(() => {
      root.render(<HostKeyModal prompt={prompt} onAnswer={() => {}} />)
    })
    const panel = container.querySelector('.pop')
    expect(panel?.className).toContain('bg-[var(--raised)]')
    expect(panel?.className).toContain(`shadow-[${SHADOW_2}]`)
  })

  it('SaveDiscardModal panel uses --raised + shadow-2', () => {
    act(() => {
      root.render(
        <SaveDiscardModal onCancel={() => {}} onDiscard={() => {}} onSave={() => {}} saving={false} />
      )
    })
    const panel = container.querySelector('.pop')
    expect(panel?.className).toContain('bg-[var(--raised)]')
    expect(panel?.className).toContain(`shadow-[${SHADOW_2}]`)
  })

  it('SshConnectModal panel uses --raised + shadow-2', () => {
    const profiles: SshProfile[] = []
    act(() => {
      root.render(
        <SshConnectModal
          profiles={profiles}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
    })
    const panel = container.querySelector('.pop')
    expect(panel?.className).toContain('bg-[var(--raised)]')
    expect(panel?.className).toContain(`shadow-[${SHADOW_2}]`)
  })

  it("HandoffOverlay's modal variant panel uses --raised + shadow-2", () => {
    const state: HandoffUiState = {
      request: 1,
      session: 1,
      sessionTitle: 's',
      provider: 'claude',
      phase: 'done',
      text: '',
      markdown: 'hi',
      savedPath: '',
      error: ''
    }
    act(() => {
      root.render(
        <HandoffOverlay
          state={state}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
          variant="modal"
        />
      )
    })
    const panel = container.querySelector('.pop')
    expect(panel?.className).toContain('bg-[var(--raised)]')
    expect(panel?.className).toContain(`shadow-[${SHADOW_2}]`)
  })
})

describe('overlays-03: glass where the site earns it, per the ladder table', () => {
  it('ShortcutSheet carries overlay glass (a keyboard reference sheet, same idiom as the palette)', () => {
    const overrides: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }
    act(() => {
      root.render(
        <KeymapOverridesContext.Provider value={overrides}>
          <ShortcutSheet onClose={() => {}} />
        </KeymapOverridesContext.Provider>
      )
    })
    const panel = container.querySelector('.pop')
    expect(panel?.className).toContain('bg-[var(--material-overlay-glass-bg)]')
    expect(panel?.className).toContain('backdrop-filter')
    expect(panel?.className).toContain('shadow-[var(--material-overlay-shadow)]')
    expect(panel?.getAttribute('data-material')).toBe('overlay-glass')
  })

  it('AddPanePopover wears OVERLAY_GLASS_OVERLAY_CLS rather than respelling the recipe', () => {
    act(() => {
      root.render(
        <AddPanePopover
          right={0}
          y={0}
          hasWorkspace
          keymapOverrides={{ bindings: {}, shortcuts_enabled: true } as ClientKeymapOverrides}
          onClose={() => {}}
          onInsertPane={() => {}}
          onNewTerminal={() => {}}
          onSpawnAgent={() => {}}
          onNewGrid={() => {}}
          onNewSession={() => {}}
          agentProfiles={null}
        />
      )
    })
    const panel = container.querySelector('[data-testid="add-pane-popover"]')
    expect(panel?.className).toContain('bg-[var(--material-overlay-glass-bg)]')
    expect(panel?.className).toContain('shadow-[var(--material-overlay-shadow)]')
    expect(panel?.className).not.toContain('rgba(')
    expect(panel?.getAttribute('data-material')).toBe('overlay-glass')
  })
})

describe('motion-r2: panel exits run faster than panel entrances', () => {
  it('ConfirmModal panel enters at --animate-t-panel and exits at the faster --animate-t-fast', () => {
    act(() => {
      root.render(<ConfirmModal message="Are you sure?" onConfirm={() => {}} onCancel={() => {}} />)
    })
    const panel = container.querySelector('.pop')
    expect(panel?.className).toContain('animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)]')
    expect(panel?.className).toContain(
      '[.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]'
    )
  })

  it("HandoffOverlay's full-pane variant also exits faster than it enters", () => {
    const state: HandoffUiState = {
      request: 1,
      session: 1,
      sessionTitle: 's',
      provider: 'claude',
      phase: 'done',
      text: '',
      markdown: 'hi',
      savedPath: '',
      error: ''
    }
    act(() => {
      root.render(
        <HandoffOverlay state={state} onCancel={() => {}} onClose={() => {}} onPaste={() => {}} />
      )
    })
    const pane = container.querySelector('.handoff-overlay')
    expect(pane?.className).toContain(
      '[.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]'
    )
  })
})

describe('motion-r5 / motion-k9: HandoffOverlay reconnect dot-pulse is motion-safe-gated', () => {
  it('the "generating…" dot never runs unconditionally', () => {
    flushSync(() => {
      root.render(
        <HandoffOverlay
          state={{
            request: 1,
            session: 1,
            sessionTitle: 's',
            provider: 'claude',
            phase: 'generating',
            text: 'partial text so the skeleton is not what renders',
            markdown: '',
            savedPath: '',
            error: ''
          }}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    })
    const dot = container.querySelector('.bg-primary')
    expect(dot?.className).toContain('motion-safe:animate-[dot-pulse_1.2s_ease-in-out_infinite]')
    expect(dot?.className).not.toMatch(/(?<!motion-safe:)animate-\[dot-pulse/)
  })
})
