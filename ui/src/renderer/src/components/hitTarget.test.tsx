// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Chip } from './Chip'
import { Segmented } from './Segmented'
import { Disclosure } from './Disclosure'
import { NavSwitch } from './nav/navChrome'
import { Toggle } from './settingsPrimitives'
import { HIT_TARGET_28 } from './hitTarget'

describe('hit targets — charter §10 density floor', () => {
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
  })

  function expectExpandedHitArea(el: Element | null, visibleHeightClass: string): void {
    expect(el).not.toBeNull()
    const cls = el!.className
    for (const token of HIT_TARGET_28.split(/\s+/)) {
      expect(cls, `missing "${token}" — hit area is not expanded`).toContain(token)
    }
    expect(cls, 'visible height changed — the floor was met by resizing, not by expanding the hit area')
      .toContain(visibleHeightClass)
  }

  it("Chip's remove button keeps its 16px box and hit-tests to the floor", () => {
    act(() => {
      root.render(<Chip variant="removable" label="claude-opus-5" onRemove={() => {}} />)
    })
    expectExpandedHitArea(container.querySelector('button[aria-label^="Remove"]'), 'h-[16px]')
  })

  it("Segmented's retry keeps its 22px box and hit-tests to the floor", () => {
    act(() => {
      root.render(
        <Segmented
          aria-label="Effort"
          options={[{ value: 'a', label: 'A' }]}
          value="a"
          onChange={() => {}}
          error={{ message: 'Could not load options', onRetry: () => {} }}
        />
      )
    })
    expectExpandedHitArea(container.querySelector('button'), 'h-[var(--h-ctl-mini)]')
  })

  it("Disclosure's retry keeps its 22px box and hit-tests to the floor", () => {
    act(() => {
      root.render(
        <Disclosure
          summary="Install dependencies"
          defaultOpen
          error={{ message: 'npm install failed', onRetry: () => {}, elapsedMs: 4200 }}
        >
          body
        </Disclosure>
      )
    })
    const retry = [...container.querySelectorAll('button')].find((b) =>
      b.className.includes('h-[var(--h-ctl-mini)]')
    )
    expectExpandedHitArea(retry ?? null, 'h-[var(--h-ctl-mini)]')
  })

  it("NavSwitch's 17px track hits the floor without growing", () => {
    act(() => {
      root.render(<NavSwitch on={false} label="Orchestration" onChange={() => {}} />)
    })
    expectExpandedHitArea(container.querySelector('button[role="switch"]'), 'h-[17px]')
  })

  it("Toggle's 20px track hits the floor without growing", () => {
    act(() => {
      root.render(<Toggle on={false} onChange={() => {}} />)
    })
    expectExpandedHitArea(container.querySelector('button[role="switch"]'), 'h-[20px]')
  })
})
