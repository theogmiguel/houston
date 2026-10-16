// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { PaneOps } from '../houston/paneOps'
import { PaneOpsContext } from '../houston/paneOpsContext'
import { SessionPane } from './SessionPane'
import { ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 })
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })

;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
  listShells: vi.fn().mockResolvedValue([]),
  pathKind: vi.fn().mockResolvedValue(null),
  openPath: vi.fn().mockResolvedValue({ ok: true })
}

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 1,
    agent: 'claude',
    project_dir: '/home/tester/project',
    cwd: '/home/tester/project',
    state: 'interrupted',
    title: 'Amber Falcon',
    hidden: false,
    ...over
  } as SessionInfo
}

const SENTENCE = 'This conversation could not be resumed.'

describe('recovery footer', () => {
  let container: HTMLDivElement
  let root: Root
  let ops: PaneOps
  let respawn: ReturnType<typeof vi.fn>
  let reconnect: Mock<(id: number) => void>

  function render(info: SessionInfo): void {
    const client = {
      subscribe: () => () => {},
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn().mockReturnValue(true),
      respawnSession: respawn,
      send: vi.fn(),
      closeSession: vi.fn(),
      sessionCwd: vi.fn().mockResolvedValue('/home/tester/project')
    } as unknown as HoustonClient
    act(() => {
      root.render(
        <PaneOpsContext.Provider value={ops}>
          <SessionPane
            client={client}
            info={info}
            theme="warm-espresso"
            active={true}
            connected={true}
            fontSize={13}
            copyOnSelect={false}
            stripBoxGlyphs={false}
            showProject={false}
            registerOutput={() => () => {}}
            shellIntegration={false}
            onReconnectSsh={reconnect}
            onActivate={() => {}}
            onExpand={() => {}}
            onZoom={() => {}}
            onShellZoom={() => {}}
            onSplit={() => {}}
            onHeaderPointerDown={() => {}}
            onHandoff={() => {}}
            onOpenFile={() => {}}
            onOpenDir={() => {}}
          />
        </PaneOpsContext.Provider>
      )
    })
  }

  const footer = (): HTMLElement | null => container.querySelector('[data-testid="recovery-footer"]')
  const button = (label: string): HTMLButtonElement => {
    const found = Array.from(footer()?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === label)
    if (!found) throw new Error(`no footer button labelled ${label}`)
    return found
  }
  const click = (el: Element): void => {
    act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  }
  function tooltipText(): string | null {
    const sentence = footer()?.querySelector<HTMLElement>('[tabindex="0"]')
    if (!sentence) return null
    act(() => sentence.focus())
    return document.querySelector('[role="tooltip"]')?.textContent ?? null
  }

  beforeEach(() => {
    ops = new PaneOps()
    respawn = vi.fn((session: number) => ops.beginRespawn(session))
    reconnect = vi.fn<(id: number) => void>()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each([
    ['invalid-cwd', 'The folder ~/project no longer exists.'],
    ['budget', 'Too many sessions were restoring at startup, so this one was held back.'],
    ['previous-crash', 'Houston ended unexpectedly last time, so this session was not restarted automatically.'],
    ['safe-mode', 'Safe mode skipped automatic restore.'],
    ['spawn-failed', 'The agent could not be started.']
  ] as const)('a %s husk shows one footer line with the reason in a tooltip', (reason, sentence) => {
    render(makeSession({ restore_deferred: reason }))
    expect(footer()?.textContent).toContain(SENTENCE)
    expect(footer()?.textContent).not.toContain(sentence)
    expect(tooltipText()).toBe(sentence)
    expect(footer()?.querySelector('[title]')).toBeNull()
  })

  it('appends the daemon resume notice to the reason', () => {
    render(makeSession({ restore_deferred: 'spawn-failed', resume_notice: 'Hook drop was unreadable.' }))
    expect(tooltipText()).toBe('The agent could not be started. Hook drop was unreadable.')
  })

  it('Try again resumes and New conversation starts fresh', () => {
    render(makeSession({ restore_deferred: 'budget' }))
    click(button('Try again'))
    expect(respawn).toHaveBeenLastCalledWith(1, false)
    act(() => ops.respawnSettled(1))
    click(button('New conversation'))
    expect(respawn).toHaveBeenLastCalledWith(1, false, undefined, undefined, undefined, true)
  })

  it('disables both buttons while Try again is in flight and re-enables them when the daemon answers', () => {
    render(makeSession({ restore_deferred: 'budget' }))
    click(button('Try again'))
    expect(button('Try again').disabled).toBe(true)
    expect(button('New conversation').disabled).toBe(true)
    act(() => ops.respawnSettled(1))
    expect(button('Try again').disabled).toBe(false)
    expect(button('New conversation').disabled).toBe(false)
  })

  it('shows a refusal in the footer in place of the sentence and re-enables the buttons', () => {
    render(makeSession({ restore_deferred: 'invalid-cwd' }))
    click(button('Try again'))
    act(() => {
      expect(ops.attribute({ message: 'respawn refused: the folder is gone', context: 'session:1' })).toBe(1)
    })
    expect(footer()?.textContent).toContain('respawn refused: the folder is gone')
    expect(footer()?.textContent).not.toContain(SENTENCE)
    expect(button('Try again').disabled).toBe(false)
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  })

  it('an SSH husk offers only Reconnect', () => {
    render(makeSession({ agent: 'ssh', restore_deferred: 'ssh' }))
    expect(footer()?.textContent).toContain('SSH sessions reconnect manually.')
    expect(Array.from(footer()?.querySelectorAll('button') ?? []).map((b) => b.textContent?.trim())).toEqual(['Reconnect'])
    click(button('Reconnect'))
    expect(reconnect).toHaveBeenCalledWith(1)
    expect(respawn).not.toHaveBeenCalled()
  })

  it('shows no footer for a live pane or a stopped pane without a restore reason, and no top bar', () => {
    render(makeSession({ state: 'running', restore_deferred: 'budget' }))
    expect(footer()).toBeNull()
    render(makeSession({ state: 'exited' }))
    expect(footer()).toBeNull()
    render(makeSession({ restore_deferred: 'budget' }))
    expect(container.querySelector('[data-testid="session-recovery-notice"]')).toBeNull()
    expect(container.textContent).not.toContain('Session restore deferred')
  })

  it('keeps the sleep notice', () => {
    render(makeSession({ state: 'running', sleep_notice: 'Sleeping to save memory.' }))
    expect(container.querySelector('[data-testid="session-recovery-notice"]')?.textContent).toBe('Sleeping to save memory.')
  })

  it('a live pane that fell back to a fresh conversation shows a dismissable footer with the reason', () => {
    render(makeSession({ state: 'running', resume_notice: 'The saved conversation belongs to a different working directory.' }))
    const notice = container.querySelector<HTMLElement>('[data-testid="resume-notice"]')
    expect(notice?.textContent).toContain('Started a new conversation; the previous one could not be resumed.')
    expect(notice?.textContent).not.toContain('different working directory')
    act(() => notice?.querySelector<HTMLElement>('[tabindex="0"]')?.focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'The saved conversation belongs to a different working directory.'
    )
    click(notice!.querySelector('button[aria-label="Dismiss notice"]')!)
    expect(container.querySelector('[data-testid="resume-notice"]')).toBeNull()
  })
})
