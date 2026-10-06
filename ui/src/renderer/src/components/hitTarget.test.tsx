// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Chip } from './ui/Chip'
import { Segmented } from './ui/SegmentedControl'
import { Disclosure } from './ui/Disclosure'
import { FieldSwitch } from './ui/navPrimitives'
import { Toggle } from './ui/settingsPrimitives'
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
    expectExpandedHitArea(container.querySelector('button[aria-label^="Remove"]'), 'h-[var(--h-chip-dismiss)]')
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

  it("FieldSwitch's 17px track hits the floor without growing", () => {
    act(() => {
      root.render(<FieldSwitch on={false} label="Orchestration" onChange={() => {}} />)
    })
    const theme = readFileSync(resolve(__dirname, '..', 'theme.css'), 'utf8')
    expect(theme).toMatch(/--h-switch-track:\s*17px;/)
    expectExpandedHitArea(container.querySelector('button[role="switch"]'), 'h-[var(--h-switch-track)]')
  })

  it("Toggle's 20px track hits the floor without growing", () => {
    act(() => {
      root.render(<Toggle on={false} onChange={() => {}} />)
    })
    expectExpandedHitArea(container.querySelector('button[role="switch"]'), 'h-[var(--h-settings-switch)]')
  })
})
