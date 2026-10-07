// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { TagInfo } from '../houston/generated/TagInfo'
import { MAX_TAGS_PER_SESSION } from '../houston/generated/DEFAULTS'
import { TagsContext } from '../layout/tagsContext'
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

const TAGS: TagInfo[] = [
  { id: 1, name: 'code review', color: '#a78bfa' },
  { id: 2, name: 'wait-human', color: '#f59e0b' },
  { id: 3, name: 'spike', color: '#34d399' }
]

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 7,
    agent: 'shell',
    project_dir: '/home/tester/project',
    cwd: '/home/tester/project',
    state: 'running',
    title: 'session-7',
    hidden: false,
    tags: [],
    ...over
  } as SessionInfo
}

describe('pane tags', () => {
  let container: HTMLDivElement
  let root: Root
  let setSessionTags: ReturnType<typeof vi.fn>
  let fakeClient: HoustonClient

  function render(info: SessionInfo, tags: TagInfo[] = TAGS): void {
    act(() => {
      root.render(
        <TagsContext.Provider value={tags}>
          <SessionPane
            client={fakeClient}
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
        </TagsContext.Provider>
      )
    })
  }

  function openPaneMenu(): void {
    const pane = container.querySelector('section') as HTMLElement
    act(() => {
      pane.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
  }

  const tagRow = (id: number): HTMLButtonElement =>
    container.querySelector(`[data-testid="pane-menu-tag-item"][data-tag="${id}"]`) as HTMLButtonElement

  const headerChipNames = (): string[] =>
    [...container.querySelectorAll<HTMLElement>('header [data-testid="tag-chip"]')].map(
      (c) => c.textContent ?? ''
    )

  beforeEach(() => {
    setSessionTags = vi.fn()
    fakeClient = {
      subscribe: () => () => {},
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn().mockReturnValue(true),
      respawnSession: vi.fn(),
      closeSession: vi.fn(),
      setSessionTags,
      sessionCwd: vi.fn().mockResolvedValue('/home/tester/project')
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('draws the pane’s own tags in its header, first by name, and nothing for an untagged pane', () => {
    render(makeSession())
    expect(container.querySelector('header [data-testid="tag-chips"]')).toBeNull()

    render(makeSession({ tags: [2, 1] }))
    expect(headerChipNames()[0]).toContain('wait-human')
    expect(container.querySelector('header [data-testid="tag-chips-more"]')?.textContent).toBe('+1')
  })

  it('a menu tag row adds the tag to this pane only, keeping its other tags', () => {
    render(makeSession({ tags: [3] }))
    openPaneMenu()
    expect(tagRow(3).getAttribute('aria-checked')).toBe('true')
    expect(tagRow(1).getAttribute('aria-checked')).toBe('false')

    act(() => tagRow(1).click())
    expect(setSessionTags).toHaveBeenCalledTimes(1)
    expect(setSessionTags).toHaveBeenCalledWith(7, [3, 1])
  })

  it('a checked row removes the tag and leaves the menu open for the next toggle', () => {
    render(makeSession({ tags: [1, 2] }))
    openPaneMenu()
    act(() => tagRow(1).click())
    expect(setSessionTags).toHaveBeenCalledWith(7, [2])
    expect(tagRow(2)).not.toBeNull()
  })

  it('refuses a new tag at the MAX_TAGS_PER_SESSION cap, naming it, and still lets one go', () => {
    const many: TagInfo[] = Array.from({ length: MAX_TAGS_PER_SESSION + 1 }, (_, i) => ({
      id: i + 1,
      name: `t${i + 1}`,
      color: '#a78bfa'
    }))
    const full = many.slice(0, MAX_TAGS_PER_SESSION).map((t) => t.id)
    render(makeSession({ tags: full }), many)
    openPaneMenu()
    expect(tagRow(MAX_TAGS_PER_SESSION + 1).disabled).toBe(true)
    expect(tagRow(1).disabled).toBe(false)
    act(() => tagRow(1).click())
    expect(setSessionTags).toHaveBeenCalledWith(7, full.slice(1))
  })

  it('offers no tag section before any tag exists', () => {
    render(makeSession(), [])
    openPaneMenu()
    expect(container.querySelector('[data-testid="pane-menu-tag-item"]')).toBeNull()
    expect(container.textContent).not.toContain('Pane Tags')
  })
})
