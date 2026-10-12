// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { RailOptionsMenu } from './RailOptionsMenu'
import { TagPopoverHost } from '../tags/TagPopover'
import { DEFAULT_RAIL_PREFS } from '../../railPrefs'

it('offers card properties and tag management at the first menu level', () => {
  const host = document.createElement('div')
  const anchor = document.createElement('button')
  document.body.append(host, anchor)
  const root = createRoot(host)
  const change = vi.fn()
  act(() => root.render(<TagPopoverHost tags={[]} grids={[]} actions={{ onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onApply: vi.fn() }}><RailOptionsMenu anchor={anchor} prefs={DEFAULT_RAIL_PREFS} onChange={change} onClose={vi.fn()} /></TagPopoverHost>))
  const menu = document.querySelector('[data-rail-options]')!
  try {
    expect(menu.textContent).toContain('Cards show')
    expect(menu.querySelector('[data-testid="rail-manage-tags"]')).not.toBeNull()
    expect(menu.querySelector('[role="menuitemcheckbox"][aria-label="Tags"]')).not.toBeNull()
    expect(menu.textContent).not.toContain('Context %')
    act(() => menu.querySelector<HTMLButtonElement>('[aria-label="Branch and changes"]')!.click())
    expect(change.mock.calls[0][0].properties).not.toContain('checkout')
    expect(change.mock.calls[0][0].properties).not.toContain('diff')
  } finally {
    act(() => root.unmount())
    host.remove()
    anchor.remove()
  }
})
