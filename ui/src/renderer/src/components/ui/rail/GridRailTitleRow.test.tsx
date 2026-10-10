// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { GridRailTitleRow } from './GridRailTitleRow'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
})

function renderTitle(unread: boolean): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(
    <GridRailTitleRow name="Terminal" unread={unread} pinned={false} tags={[]} hasTags={false} tagDisplay="dots" pr={null} hasPr={false}
      hasCheckout={false} cardMode="detailed" checkoutLabel={null} many={false} agentCount={1} hasRemove={false} gridId="g1"
      onOpenInspector={() => {}} openTagPopover={() => {}} />,
  ))
  return host
}

describe('rail card unread marker', () => {
  it('marks unread with a bold title and an accent pip, never the needs-input amber', () => {
    const title = renderTitle(true)
    expect(title.querySelector('[data-testid="grid-name"]')!.className).toContain('font-semibold')
    const pip = title.querySelector('[data-testid="grid-unread-pip"]')!
    expect(pip.className).toContain('bg-[var(--accent)]')
    expect(pip.className).not.toContain('--warn')
    expect(pip.getAttribute('aria-label')).toBe('Unread')
  })

  it('shows no marker for a read card', () => {
    const title = renderTitle(false)
    expect(title.querySelector('[data-testid="grid-unread-pip"]')).toBeNull()
    expect(title.querySelector('[data-testid="grid-name"]')!.className).not.toContain('font-semibold')
  })
})
