// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlPanel } from './SourceControlPanel'
import { FakeClient, file } from './ChangesPane.harness'
import {
  SCM_WIDTH_DEFAULT,
  resetScmWidthForTests,
  setScmWidth,
  useScmWidth
} from '../scmPanel'
import type { HoustonClient } from '../houston/client'

class FakeResizeObserver {
  static last: FakeResizeObserver | null = null
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.last = this
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

vi.mock('./git/PullRequestTab', () => ({
  PullRequestTab: ({
    onPrPresenceChange,
    active,
    refreshSignal
  }: {
    onPrPresenceChange?: (exists: boolean) => void
    active?: boolean
    refreshSignal?: number
  }) => {
    useEffect(() => {
      const g = globalThis as unknown as { __prMounts: number }
      g.__prMounts += 1
      onPrPresenceChange?.(true)
    }, [onPrPresenceChange])
    return (
      <div
        data-testid="pr-tab"
        data-active={active ? 'true' : undefined}
        data-refresh={refreshSignal ?? 0}
      />
    )
  }
}))

interface HarnessProps {
  tab?: 'changes' | 'pull-request'
  hiddenByOverlay?: boolean
  onTab?: (tab: 'changes' | 'pull-request') => void
  seedChanges?: boolean
}

describe('SourceControlPanel', () => {
  let container: HTMLDivElement
  let host: HTMLDivElement
  let root: Root
  let widths: number[]
  let setHarness: (next: HarnessProps) => void

  const panel = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('[data-testid="source-control-panel"]')
    if (!el) throw new Error('no panel')
    return el
  }
  const handle = (): HTMLElement => {
    const el = container.querySelector<HTMLElement>('[data-testid="scm-resize-handle"]')
    if (!el) throw new Error('no resize handle')
    return el
  }
  const rendered = (): number => parseInt(panel().style.width, 10)

  const setHostWidth = (px: number): void => {
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: px })
    act(() => {
      FakeResizeObserver.last?.callback(
        [] as unknown as ResizeObserverEntry[],
        FakeResizeObserver.last as unknown as ResizeObserver
      )
    })
  }

  function Harness(): React.JSX.Element {
    const [client] = useState(() => new FakeClient())
    const [state, setState] = useState<HarnessProps>({})
    const width = useScmWidth()
    useEffect(() => {
      setHarness = (next) => {
        setState(next)
      }
    }, [])
    useEffect(() => {
      if (!state.seedChanges) return
      client.emit({
        type: 'git_status',
        dir: '/repo',
        files: [file()],
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        base: null,
        default_base: 'main'
      })
    }, [client, state.seedChanges])
    return (
      <SourceControlPanel
        dir="/repo"
        client={client as unknown as HoustonClient}
        width={width}
        onWidth={(px) => {
          widths.push(px)
          setScmWidth(px)
        }}
        onResetWidth={() => {
          setScmWidth(SCM_WIDTH_DEFAULT)
        }}
        tab={state.tab ?? 'changes'}
        onTab={state.onTab ?? (() => {})}
        hiddenByOverlay={state.hiddenByOverlay}
      />
    )
  }

  const settle = async (testid: string): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      if (container.querySelector(`[data-testid="${testid}"]`)) return
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error(`${testid} never rendered`)
  }

  beforeEach(() => {
    resetScmWidthForTests()
    localStorage.clear()
    widths = []
    setHarness = () => {}
    ;(globalThis as unknown as { __prMounts: number }).__prMounts = 0
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
    container = document.createElement('div')
    host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 1200 })
    container.appendChild(host)
    document.body.appendChild(container)
    root = createRoot(host)
    act(() => {
      root.render(<Harness />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('positions the divider as the terminal splitter, on the 4% keyboard step', async () => {
    await act(async () => {})
    expect(handle().getAttribute('role')).toBe('separator')
    expect(handle().getAttribute('aria-orientation')).toBe('vertical')
    expect(handle().getAttribute('aria-valuemin')).toBe('340')
    expect(handle().getAttribute('aria-valuemax')).toBe('840')
    expect(handle().getAttribute('aria-valuenow')).toBe('480')
    expect(handle().tabIndex).toBe(0)

    act(() => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(widths.at(-1)).toBe(480 + Math.round(1200 * 0.04))
    act(() => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(widths.at(-1)).toBe(480)
  })

  it('commits the pointerup position even when no animation frame ran', () => {
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1000 })
      )
    })
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 900 })
      )
    })
    expect(widths.at(-1)).toBe(580)
    expect(rendered()).toBe(580)
    expect(localStorage.getItem('tr-scm-width')).toBe('580')
  })

  it('a cancelled drag restores the width it began at, not the last frame', () => {
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1000 })
      )
    })
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 900 })
      )
    })
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointercancel', { bubbles: true, cancelable: true, clientX: 900 })
      )
    })
    expect(widths.at(-1)).toBe(480)
  })

  it('double-click and Home both return to the 480 default', () => {
    const dragTo = (x: number): void => {
      act(() => {
        handle().dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1000 })
        )
      })
      act(() => {
        handle().dispatchEvent(
          new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: x })
        )
      })
    }
    dragTo(800)
    expect(rendered()).toBe(680)
    act(() => {
      handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(rendered()).toBe(480)
    dragTo(800)
    act(() => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(rendered()).toBe(480)
  })

  it('a clamped panel still tracks the pointer from the width it shows', () => {
    act(() => {
      setScmWidth(800)
    })
    setHostWidth(1000)
    expect(rendered()).toBe(640)
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1000 })
      )
    })
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 1050 })
      )
    })
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 1050 })
      )
    })
    expect(widths.at(-1)).toBe(590)
    expect(rendered()).toBe(590)
  })

  it('a cancel or an unmoved release restores the preferred width, not the clamp', () => {
    act(() => {
      setScmWidth(800)
    })
    setHostWidth(1000)
    expect(rendered()).toBe(640)

    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1000 })
      )
    })
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 1000 })
      )
    })
    expect(widths.at(-1)).toBe(800)
    expect(localStorage.getItem('tr-scm-width')).toBe('800')

    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1000 })
      )
    })
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 1100 })
      )
    })
    act(() => {
      handle().dispatchEvent(
        new MouseEvent('pointercancel', { bubbles: true, cancelable: true, clientX: 1100 })
      )
    })
    expect(widths.at(-1)).toBe(800)
    expect(rendered()).toBe(640)
  })

  it('Changes opens first; the PR tab mounts on first visit and keeps Changes alive', async () => {
    await settle('changes-pane')
    expect(panel().getAttribute('data-tab')).toBe('changes')
    expect(container.querySelector('[data-testid="scm-pr-tab"]')).toBeNull()

    act(() => {
      setHarness({ seedChanges: true })
    })
    await settle('changes-commit-message')

    const message = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="changes-commit-message"]'
    )!
    expect(message.tagName).toBe('TEXTAREA')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )!.set!
      setter.call(message, 'draft survives')
      message.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const onTab = vi.fn()
    act(() => {
      setHarness({ tab: 'pull-request', onTab })
    })
    await settle('pr-tab')
    expect(onTab).not.toHaveBeenCalled()
    expect(panel().getAttribute('data-tab')).toBe('pull-request')
    expect(container.querySelector('[data-testid="scm-changes-tab"]')!.className).toContain(
      'hidden'
    )
    expect(container.querySelector('[data-testid="changes-pane"]')).not.toBeNull()

    act(() => {
      setHarness({ tab: 'changes', onTab })
    })
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="changes-commit-message"]')!.value
    ).toBe('draft survives')
  })

  it('the tab strip reports the choice and moves between the two tabs', async () => {
    await settle('changes-pane')
    const onTab = vi.fn()
    act(() => {
      setHarness({ onTab })
    })
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="scm-tab-pull-request"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onTab).toHaveBeenCalledWith('pull-request')
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="scm-tab-changes"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onTab).toHaveBeenCalledWith('pull-request')
  })

  it('shows a dot once the PR tab reports a pull request', async () => {
    act(() => {
      setHarness({ tab: 'pull-request' })
    })
    await settle('pr-tab')
    expect(container.querySelector('[data-testid="scm-pr-dot"]')).not.toBeNull()
  })

  it('header Refresh signals the visible tab, and only that tab, without remounting', async () => {
    act(() => {
      setHarness({ tab: 'pull-request' })
    })
    await settle('pr-tab')
    const mounts = (): number => (globalThis as unknown as { __prMounts: number }).__prMounts
    const signal = (): string =>
      container.querySelector('[data-testid="pr-tab"]')!.getAttribute('data-refresh')!
    expect(mounts()).toBe(1)
    expect(signal()).toBe('0')
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="scm-refresh"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle('pr-tab')
    expect(mounts()).toBe(1)
    expect(signal()).toBe('1')
  })

  it('the hidden overlay keeps its place and stops taking input', async () => {
    await settle('changes-pane')
    act(() => {
      setHarness({ hiddenByOverlay: true })
    })
    expect(panel().getAttribute('aria-hidden')).toBe('true')
    expect(panel().className).toContain('invisible')
    expect(panel().hasAttribute('inert')).toBe(true)
    expect(rendered()).toBe(480)
  })
})
