// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TabsPopover } from './browserTabs'
import { HIT_TARGET_28 } from './hitTarget'

describe('TabsPopover — density floor on the tab close glyph', () => {
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

  it("a tab's close button keeps its 18px box and hit-tests to the 28px floor", () => {
    act(() => {
      root.render(
        <TabsPopover
          tabs={[{ id: 1, url: 'https://example.test/', title: 'Example' }]}
          activeId={1}
          onSelect={() => {}}
          onCloseTab={() => {}}
          onNewTab={() => {}}
          onDismiss={() => {}}
        />
      )
    })
    const close = container.querySelector('button[aria-label="Close Example"]')
    expect(close).not.toBeNull()
    const cls = close!.className
    for (const token of HIT_TARGET_28.split(/\s+/)) {
      expect(cls, `missing "${token}" — hit area is not expanded`).toContain(token)
    }
    expect(cls).toContain('h-[18px]')
  })
})
