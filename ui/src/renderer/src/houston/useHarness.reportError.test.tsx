// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from './client'
import type { ServerMsg } from './generated/ServerMsg'
import { useHarness } from './useHarness'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeClient() {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    harnessState: vi.fn(),
    harnessReport: vi.fn()
  }
  const emit = (msg: ServerMsg): void => {
    act(() => handlers.get(msg.type)?.forEach((handler) => handler(msg)))
  }
  return { client, emit, asClient: client as unknown as HoustonClient }
}

function Probe({ client, workspace }: { client: HoustonClient; workspace: string }): React.JSX.Element {
  const { report, reportError, loadReport } = useHarness(client, workspace)
  return (
    <div>
      <button onClick={() => loadReport(workspace === '/one' ? 3 : 4)}>Load report</button>
      <output data-testid="report-error">{reportError?.message ?? ''}</output>
      <output data-testid="report-markdown">{report?.markdown ?? ''}</output>
    </div>
  )
}

describe('useHarness report errors', () => {
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

  it('accepts only the active report error, retries, clears on success, and drops old workspace state', () => {
    const { client, emit, asClient } = fakeClient()
    act(() => root.render(<Probe client={asClient} workspace="/one" />))
    act(() => container.querySelector('button')!.click())
    expect(client.harnessReport).toHaveBeenCalledWith(3)

    emit({ type: 'error', context: null, message: 'unrelated error' })
    emit({ type: 'error', context: 'harness_report:4', message: 'another report failed' })
    expect(container.querySelector('[data-testid="report-error"]')?.textContent).toBe('')

    emit({ type: 'error', context: 'harness_report:3', message: 'report.md is missing' })
    expect(container.querySelector('[data-testid="report-error"]')?.textContent).toBe('report.md is missing')

    act(() => container.querySelector('button')!.click())
    expect(client.harnessReport).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="report-error"]')?.textContent).toBe('')
    emit({ type: 'harness_report', review_id: 3, markdown: '# Recovered', truncated: false })
    expect(container.querySelector('[data-testid="report-markdown"]')?.textContent).toBe('# Recovered')

    act(() => root.render(<Probe client={asClient} workspace="/two" />))
    expect(container.querySelector('[data-testid="report-markdown"]')?.textContent).toBe('')
    act(() => container.querySelector('button')!.click())
    emit({ type: 'error', context: 'harness_report:3', message: 'old workspace failure' })
    expect(container.querySelector('[data-testid="report-error"]')?.textContent).toBe('')
  })
})
