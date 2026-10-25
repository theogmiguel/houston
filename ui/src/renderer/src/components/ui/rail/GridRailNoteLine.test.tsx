// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GridRailNoteLine, newestNote } from './GridRailNoteLine'
import type { RailAgentRow } from '../../rail/railCardModel'
import type { SessionInfo } from '../../../houston/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

const NOW = 1_800_000_000_000

function mount(onClear?: (session: number) => void, onRow = vi.fn()): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(
    <div onClick={onRow}>
      <GridRailNoteLine note={{ session: 4, pane: 'Max', text: 'fix implemented; running tests', phase: 'in_review', atMs: NOW - 5 * 60_000 }} now={NOW} onClear={onClear} />
    </div>
  ))
  return host
}

describe('GridRailNoteLine', () => {
  it('shows the phase, the text and its age', () => {
    const el = mount(undefined)
    expect(el.querySelector('[data-testid="grid-note"]')!.textContent).toBe('In review · fix implemented; running tests5m')
    expect(el.querySelector('[data-testid="grid-note-clear"]')).toBeNull()
  })

  it('Clear removes that pane’s note without selecting the grid', () => {
    const onClear = vi.fn()
    const onRow = vi.fn()
    const el = mount(onClear, onRow)
    act(() => el.querySelector('[data-testid="grid-note-clear"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onClear).toHaveBeenCalledWith(4)
    expect(onRow).not.toHaveBeenCalled()
  })
})

describe('newestNote', () => {
  const agent = (id: number, leading: string, note: SessionInfo['note']): RailAgentRow =>
    ({ session: { id, note } as SessionInfo, leading } as RailAgentRow)

  it('picks the newest note among the grid panes, with its pane and phase', () => {
    expect(newestNote([
      agent(1, 'Max', { text: 'reading the code', phase: 'todo', at_ms: 1_000 }),
      agent(2, 'Leo', { text: 'running tests', phase: 'in_progress', at_ms: 2_000 }),
      agent(3, 'Ivy', null)
    ])).toEqual({ session: 2, pane: 'Leo', text: 'running tests', phase: 'in_progress', atMs: 2_000 })
  })

  it('has no note when no pane wrote one', () => {
    expect(newestNote([agent(1, 'Max', null)])).toBeNull()
  })
})
