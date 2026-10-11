// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../houston/client'
import type { InboxRow } from '../houston/generated/InboxRow'
import type { DelegationResult } from '../houston/generated/DelegationResult'
import { showItemInFolder } from '../houston/bridge'
import { DelegationResults } from './DelegationResults'

vi.mock('../houston/bridge', () => ({ showItemInFolder: vi.fn().mockResolvedValue({ ok: true }) }))
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

function setup(overrides: Partial<DelegationResult> = {}) {
  const handlers = new Map<string, (message: unknown) => void>()
  const delegationResultGet = vi.fn()
  const client = { delegationResultGet, subscribe: (kind: string, callback: (message: unknown) => void) => {
    handlers.set(kind, callback)
    return () => { handlers.delete(kind) }
  } } as unknown as HoustonClient
  const result: DelegationResult = { message_id: 42, child: 2, role: 'validator', from_codename: 'code-2', summary: 'Validation findings', excerpt: 'Short preview', created_at: 1000, ready_at: 2000, provisional: false, delivered_via: 'wait', ...overrides }
  const onLoadMore = vi.fn()
  const props = { parentId: 1, client, results: [result], nextMessageId: null, truncated: false, loading: false, onLoadMore }
  const view = render(<DelegationResults {...props} />)
  return { handlers, delegationResultGet, view, props, onLoadMore }
}
const fullRow = (body: string): InboxRow => ({ id: 42n, to_session: 1, workspace: '/work', from_session: 2, kind: 'result', urgent: false, summary: 'Validation findings', body, artifacts: ['/work/output.txt'], superseded: 0, provisional: false, created_at: 1000n, attempts: 0 })

describe('durable result reads', () => {
  it('copies the complete body lazily and ignores a detail addressed to another parent', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { handlers, delegationResultGet } = setup()
    const body = `${'Full findings. '.repeat(100)}\nFinal finding beyond the excerpt.`
    expect(delegationResultGet).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }))
    expect(delegationResultGet).toHaveBeenCalledExactlyOnceWith(1, 42)
    act(() => handlers.get('delegation_result_detail')!({ parent: 9, row: fullRow(body) }))
    expect(writeText).not.toHaveBeenCalled()
    await act(async () => handlers.get('delegation_result_detail')!({ parent: 1, row: fullRow(body) }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith(body)
    expect(screen.queryByText(body)).toBeNull()
  })

  it('shows read refusals, permits retry, and reveals artifacts from the full result', async () => {
    const { handlers, delegationResultGet } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'View result' }))
    act(() => handlers.get('delegation_result_refused')!({ parent: 1, message_id: 99, message: 'Unrelated refusal' }))
    expect(screen.queryByText('Unrelated refusal')).toBeNull()
    act(() => handlers.get('delegation_result_refused')!({ parent: 1, message_id: 42, message: 'Result is unavailable' }))
    expect(screen.getByRole('alert').textContent).toContain('Result is unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'View result' }))
    expect(delegationResultGet).toHaveBeenCalledTimes(2)
    act(() => handlers.get('delegation_result_detail')!({ parent: 1, row: fullRow('Full result body') }))
    expect(screen.getByText('Full result body').tagName).toBe('PRE')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '/work/output.txt' })))
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith('/work/output.txt')
  })

  it('labels staged and provisional previews honestly and exposes the page boundary', () => {
    const { view, props, onLoadMore } = setup({ ready_at: null, provisional: true, reason: 'Interrupted partial result' })
    expect(screen.getByText('Provisional result')).toBeTruthy()
    expect(screen.getByText('Interrupted partial result')).toBeTruthy()
    view.rerender(<DelegationResults {...props} results={[{ ...props.results[0], provisional: false }]} nextMessageId={42} truncated />)
    expect(screen.getByText('Result staged')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load older results' }))
    expect(onLoadMore).toHaveBeenCalledOnce()
    expect(screen.getByText(/up to 256/)).toBeTruthy()
  })

  it('ignores a previous parent’s detail and delayed clipboard completion after switching parents', async () => {
    let finishCopy!: () => void
    const writeText = vi.fn().mockReturnValue(new Promise<void>((resolve) => { finishCopy = resolve }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { handlers, view, props } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }))
    const oldHandler = handlers.get('delegation_result_detail')!
    act(() => oldHandler({ parent: 1, row: fullRow('First parent body') }))
    expect(screen.getByRole('button', { name: 'Copy result' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<DelegationResults {...props} parentId={9} />)
    fireEvent.click(screen.getByRole('button', { name: 'View result' }))
    act(() => oldHandler({ parent: 1, row: fullRow('Stale parent body') }))
    expect(screen.queryByText('Stale parent body')).toBeNull()
    await act(async () => finishCopy())
    expect(screen.queryByText('Result copied')).toBeNull()
    expect(screen.getByRole('button', { name: 'View result' }).hasAttribute('disabled')).toBe(true)
    act(() => handlers.get('delegation_result_detail')!({ parent: 9, row: fullRow('Current parent body') }))
    expect(screen.getByText('Current parent body')).toBeTruthy()
  })

  it('bounds a clipboard action and ignores its late completion after the read times out', async () => {
    vi.useFakeTimers()
    let finishCopy!: () => void
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockReturnValue(new Promise<void>((resolve) => { finishCopy = resolve })) } })
    const { handlers } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }))
    act(() => handlers.get('delegation_result_detail')!({ parent: 1, row: fullRow('Complete body') }))
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole('alert').textContent).toContain('Result action did not complete')
    fireEvent.click(screen.getByRole('button', { name: 'View result' }))
    expect(screen.getByText('Complete body')).toBeTruthy()
    await act(async () => finishCopy())
    expect(screen.queryByText('Result copied')).toBeNull()
    expect(screen.getByRole('button', { name: 'Hide result' }).hasAttribute('disabled')).toBe(false)
  })
})
