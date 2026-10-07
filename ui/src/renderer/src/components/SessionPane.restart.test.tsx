// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
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
    state: 'running',
    title: 'Amber Falcon',
    hidden: false,
    ...over
  } as SessionInfo
}

describe('pane Restart: Resume conversation and Start fresh', () => {
  let container: HTMLDivElement
  let root: Root
  let respawn: ReturnType<typeof vi.fn>

  function render(info: SessionInfo): void {
    const client = {
      subscribe: () => () => {},
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn().mockReturnValue(true),
      respawnSession: respawn,
      closeSession: vi.fn(),
      sessionCwd: vi.fn().mockResolvedValue('/home/tester/project')
    } as unknown as HoustonClient
    act(() => {
      root.render(
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
          onReconnectSsh={() => {}}
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
      )
    })
  }

  function openPaneMenu(): void {
    const pane = container.querySelector('.pane') ?? container.querySelector('section')
    if (!(pane instanceof HTMLElement)) throw new Error('no pane section rendered')
    act(() => {
      pane.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
  }

  function labels(): string[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.ctx-item')).map(
      (b) => b.textContent ?? ''
    )
  }

  function row(label: string): HTMLButtonElement {
    const hit = Array.from(container.querySelectorAll<HTMLButtonElement>('.ctx-item')).find((b) =>
      b.textContent?.includes(label)
    )
    if (!hit) throw new Error(`no menu row labelled ${label}`)
    return hit
  }

  function click(el: Element): void {
    act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  }

  function dialog(): HTMLElement | null {
    return container.ownerDocument.querySelector('[role="dialog"], [role="alertdialog"]')
  }

  function confirmButton(label: string): HTMLButtonElement {
    const hit = Array.from(
      container.ownerDocument.querySelectorAll<HTMLButtonElement>('button')
    ).find((b) => b.textContent?.trim() === label && dialog()?.contains(b))
    if (!hit) throw new Error(`no confirm button labelled ${label}`)
    return hit
  }

  beforeEach(() => {
    respawn = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('a resumable husk offers Resume conversation first and Start fresh second', () => {
    render(makeSession({ state: 'interrupted', resumable: true }))
    openPaneMenu()
    const all = labels()
    const resume = all.findIndex((l) => l.includes('Resume conversation'))
    const fresh = all.findIndex((l) => l.includes('Start fresh'))
    expect(resume).toBeGreaterThanOrEqual(0)
    expect(fresh).toBe(resume + 1)
    expect(all.some((l) => l.trim() === 'Restart')).toBe(false)

    click(row('Start fresh'))
    expect(respawn).toHaveBeenLastCalledWith(1, false, undefined, undefined, undefined, true)

    const header = container.querySelector('header button[aria-label="Restart"]')
    if (!header) throw new Error('no header Restart button on a husk')
    click(header)
    expect(respawn).toHaveBeenLastCalledWith(1, false)
  })

  it('a pane without a handle offers a single Restart', () => {
    render(makeSession({ state: 'interrupted', resumable: false }))
    openPaneMenu()
    const all = labels()
    expect(all.filter((l) => l.includes('Restart'))).toHaveLength(1)
    expect(all.some((l) => l.includes('Resume conversation'))).toBe(false)
    expect(all.some((l) => l.includes('Start fresh'))).toBe(false)
    click(row('Restart'))
    expect(respawn).toHaveBeenLastCalledWith(1, false)

    const header = container.querySelector('header button[aria-label="Restart"]')
    if (!header) throw new Error('no header Restart button on a husk')
    click(header)
    expect(respawn).toHaveBeenLastCalledWith(1, false)
  })

  it('a live pane confirms before either restart', () => {
    render(makeSession({ state: 'running', resumable: true }))

    openPaneMenu()
    click(row('Resume conversation'))
    expect(respawn).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('same conversation')
    click(confirmButton('Resume conversation'))
    expect(respawn).toHaveBeenLastCalledWith(1, false, undefined, undefined, true)

    openPaneMenu()
    click(row('Start fresh'))
    expect(respawn).toHaveBeenCalledTimes(1)
    expect(dialog()?.textContent).toContain('a fresh CLI starts')
    click(confirmButton('Start fresh'))
    expect(respawn).toHaveBeenLastCalledWith(1, false, undefined, undefined, true, true)
  })

  it('a fallback notice shows once until dismissed', () => {
    render(makeSession({ resume_notice: 'x' }))
    const notices = container.querySelectorAll('[data-testid="resume-notice"]')
    expect(notices).toHaveLength(1)
    expect(notices[0].textContent).toContain('x')
    const dismiss = notices[0].querySelector('button[aria-label="Dismiss notice"]')
    if (!dismiss) throw new Error('no dismiss control')
    click(dismiss)
    expect(container.querySelector('[data-testid="resume-notice"]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    render(makeSession({ id: 2 }))
    expect(container.querySelector('[data-testid="resume-notice"]')).toBeNull()
  })
})
