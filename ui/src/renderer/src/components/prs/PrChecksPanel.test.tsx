// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, PrCheck } from '../../houston/client'
import { PrChecksPanel } from './PrChecksPanel'
import { PrChecksList, usePrChecksState } from './usePrChecksState'

const check: PrCheck = {
  name: 'core-checks',
  state: 'failing',
  url: 'https://github.com/acme/repo/actions/runs/12',
  run_id: 12,
}

function fakeClient(): {
  client: HoustonClient
  emit: (message: unknown) => void
  prCheckLog: ReturnType<typeof vi.fn>
} {
  let handler: ((message: never) => void) | null = null
  const prCheckLog = vi.fn()
  const client = {
    subscribe: vi.fn((_kind: string, next: (message: never) => void) => {
      handler = next
      return () => {
        handler = null
      }
    }),
    prCheckLog,
  } as unknown as HoustonClient
  return { client, prCheckLog, emit: (message) => handler?.(message as never) }
}

function SharedChecks({
  client,
  onPasteToAgent,
  onCreateAgent,
  onOpenPane,
}: {
  client: HoustonClient
  onPasteToAgent?: (session: number, text: string) => void
  onCreateAgent?: (provider: string, text: string) => Promise<number | null>
  onOpenPane?: (session: number) => void
}): React.JSX.Element {
  const state = usePrChecksState({
    client,
    dir: '/repo',
    number: 42,
    url: 'https://github.com/acme/repo/pull/42',
    branch: 'feature',
    checks: [check],
    agents: [{ session: 9, provider: 'Claude', label: 'Review pane', checkout: 'wt/review' }],
    onPasteToAgent,
    onCreateAgent,
    onOpenPane,
  })
  return (
    <>
      <PrChecksPanel state={state} />
      <div role="dialog" aria-label="Pull request checks">
        <PrChecksList state={state} />
      </div>
    </>
  )
}

afterEach(cleanup)

describe('PR checks state', () => {
  it('shares expanded check and lazy log state between Summary and the checks popover', () => {
    const { client, emit, prCheckLog } = fakeClient()
    render(<SharedChecks client={client} />)
    expect(prCheckLog).toHaveBeenCalledWith('/repo', 12)
    const logs = screen.getAllByTestId('pr-check-log-12')
    expect(logs).toHaveLength(2)
    act(() =>
      emit({
        type: 'pr_check_log',
        dir: '/repo',
        run_id: 12,
        lines: ['failed assertion'],
        truncated: false,
        available: true,
      }),
    )
    expect(screen.getAllByTestId('pr-check-log-12').every((log) => log.textContent?.includes('failed assertion'))).toBe(
      true,
    )
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Pull request checks' })).getByRole('button', { name: /core-checks/ }),
    )
    expect(
      screen
        .getAllByRole('button', { name: /core-checks/ })
        .every((button) => button.getAttribute('aria-expanded') === 'false'),
    ).toBe(true)
  })

  it('pastes the log context to the chosen agent without submitting it', () => {
    const { client } = fakeClient()
    const onPasteToAgent = vi.fn()
    render(<SharedChecks client={client} onPasteToAgent={onPasteToAgent} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Fix with agent' })[0])
    const picker = screen.getAllByTestId('pr-check-picker-12')[0]
    fireEvent.click(within(picker).getAllByRole('button', { name: /Claude · Review pane/ })[0])
    expect(onPasteToAgent).toHaveBeenCalledWith(9, expect.stringContaining('Pull request: #42'))
    expect(onPasteToAgent.mock.calls[0][1]).toContain('Branch: feature')
    expect(screen.getAllByText(/Sent to Review pane/).length).toBe(2)
  })

  it('opens the session returned by a newly created check agent', async () => {
    const { client } = fakeClient()
    const onCreateAgent = vi.fn().mockResolvedValue(117)
    const onOpenPane = vi.fn()
    render(<SharedChecks client={client} onCreateAgent={onCreateAgent} onOpenPane={onOpenPane} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Fix with agent' })[0])
    const picker = screen.getAllByTestId('pr-check-picker-12')[0]
    fireEvent.click(within(picker).getByRole('button', { name: 'New Codex pane' }))
    const openButtons = await screen.findAllByRole('button', { name: 'Open pane' })
    fireEvent.click(openButtons[0])
    expect(onCreateAgent).toHaveBeenCalledWith('Codex', expect.stringContaining('Pull request: #42'))
    expect(onOpenPane).toHaveBeenCalledWith(117)
  })

  it('fixes a failed check with a new ZCode pane', async () => {
    const { client } = fakeClient()
    const onCreateAgent = vi.fn().mockResolvedValue(118)
    render(<SharedChecks client={client} onCreateAgent={onCreateAgent} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Fix with agent' })[0])
    const picker = screen.getAllByTestId('pr-check-picker-12')[0]
    fireEvent.click(within(picker).getByRole('button', { name: 'New ZCode pane' }))
    await screen.findAllByRole('button', { name: 'Open pane' })
    expect(onCreateAgent).toHaveBeenCalledWith('ZCode', expect.stringContaining('Pull request: #42'))
  })
})
