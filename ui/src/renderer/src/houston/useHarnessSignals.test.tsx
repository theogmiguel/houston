// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from './client'
import type { ServerMsg } from './generated/ServerMsg'
import { useHarnessSignals } from './useHarnessSignals'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ client }: { client: HoustonClient }): React.JSX.Element {
  const rows = useHarnessSignals(client)
  return <div>{rows.reduce((total, row) => total + row.attention, 0)}</div>
}

describe('useHarnessSignals', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('loads the overview, refreshes it on changes, and unsubscribes on unmount', () => {
    const handlers = new Map<string, (msg: ServerMsg) => void>()
    const off = vi.fn((type: string) => handlers.delete(type))
    const client = {
      subscribe: vi.fn((type: string, callback: (msg: ServerMsg) => void) => {
        handlers.set(type, callback)
        return () => off(type)
      }),
      harnessOverviewGet: vi.fn()
    } as unknown as HoustonClient
    act(() => root.render(<Probe client={client} />))
    expect(client.harnessOverviewGet).toHaveBeenCalledOnce()

    act(() => handlers.get('harness_changed')?.({ type: 'harness_changed', workspace: '/a' }))
    expect(client.harnessOverviewGet).toHaveBeenCalledTimes(2)

    act(() => handlers.get('harness_overview')?.({
      type: 'harness_overview',
      rows: [{ workspace: '/a', open: 1, fixing: 1, awaiting_verification: 0, not_seen: 0, resolved: 0, dismissed: 0, seen_review_id: 1, attention: 2 }]
    }))
    expect(container.textContent).toBe('2')

    act(() => root.unmount())
    expect(off).toHaveBeenCalledWith('harness_overview')
    expect(off).toHaveBeenCalledWith('harness_changed')
  })
})
