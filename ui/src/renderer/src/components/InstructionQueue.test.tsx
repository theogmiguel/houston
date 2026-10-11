// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../houston/client'
import type { InstructionInfo } from '../houston/generated/InstructionInfo'
import type { InstructionQueueSnapshot } from '../houston/generated/InstructionQueueSnapshot'
import { InstructionQueue } from './InstructionQueue'

afterEach(cleanup)
const instruction = (id: string, state: InstructionInfo['state']): InstructionInfo => ({ id, mode: 'queue', state, request_id: null, preview: `Preview of ${id}`, created_at: 1000, updated_at: 2000, hold_reason: state === 'held_after_recovery' ? 'Daemon restarted before delivery' : null })
const snapshot = (items: InstructionInfo[]): InstructionQueueSnapshot => ({ session: 2, queued_count: items.filter((item) => item.state === 'queued').length, held_count: items.filter((item) => item.state === 'held_after_recovery').length, uncertain_count: items.filter((item) => item.state === 'uncertain').length, hold_reason: 'Recovery requires deliberate resume', items, truncated: false })
function setup() {
  const handlers = new Map<string, (message: unknown) => void>()
  const methods = { instructionQueueList: vi.fn(), instructionGet: vi.fn(), instructionCancel: vi.fn(), instructionResume: vi.fn() }
  const client = { ...methods, subscribe: (kind: string, callback: (message: unknown) => void) => {
    handlers.set(kind, callback)
    return () => { handlers.delete(kind) }
  } } as unknown as HoustonClient
  const onOpenPane = vi.fn()
  render(<InstructionQueue sessionId={2} client={client} onOpenPane={onOpenPane} />)
  return { handlers, methods, onOpenPane }
}

describe('durable instruction controls', () => {
  it('keeps recovery holds until explicit resume and waits for authoritative cancellation', () => {
    const { handlers, methods } = setup()
    const held = instruction('held-1', 'held_after_recovery')
    act(() => handlers.get('instruction_queue')!({ snapshot: snapshot([held]) }))
    expect(methods.instructionQueueList).toHaveBeenCalledExactlyOnceWith(2)
    expect(screen.getByText('Instructions · 0 queued · 1 held · 0 uncertain')).toBeTruthy()
    expect(screen.getByText('Recovery requires deliberate resume')).toBeTruthy()
    expect(screen.getByText('1. Held after recovery · queue')).toBeTruthy()
    expect(methods.instructionResume).not.toHaveBeenCalled()
    expect(document.querySelector('details')?.open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Resume instruction' }))
    expect(methods.instructionResume).toHaveBeenCalledExactlyOnceWith(2, 'held-1')
    expect(screen.getByText('1. Held after recovery · queue')).toBeTruthy()
    act(() => handlers.get('instruction_refused')!({ session: 2, instruction_id: 'held-1', message: 'Writer is active; resume is unavailable' }))
    expect(screen.getByRole('alert').textContent).toContain('Writer is active')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel instruction' }))
    expect(methods.instructionCancel).toHaveBeenCalledExactlyOnceWith(2, 'held-1')
    expect(screen.queryByText('1. Cancelled · queue')).toBeNull()
    act(() => handlers.get('instruction_queue')!({ snapshot: snapshot([{ ...held, state: 'cancelled' }]) }))
    expect(screen.getByText('1. Cancelled · queue')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume instruction' })).toBeNull()
  })

  it('offers lazy inspection and cancellation for uncertain delivery without replay', () => {
    const { handlers, methods, onOpenPane } = setup()
    const uncertain = instruction('uncertain-1', 'uncertain')
    act(() => handlers.get('instruction_queue')!({ snapshot: { ...snapshot([uncertain]), truncated: true } }))
    expect(methods.instructionGet).not.toHaveBeenCalled()
    expect(methods.instructionResume).not.toHaveBeenCalled()
    expect(document.querySelector('details')?.open).toBe(true)
    expect(screen.queryByRole('button', { name: 'Resume instruction' })).toBeNull()
    expect(screen.getByText('Preview')).toBeTruthy()
    expect(screen.getByText(/up to 32/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect instruction' }))
    expect(methods.instructionGet).toHaveBeenCalledExactlyOnceWith(2, 'uncertain-1')
    act(() => handlers.get('instruction_detail')!({ detail: { session: 9, instruction: uncertain, body: 'Wrong session' } }))
    expect(screen.queryByText('Wrong session')).toBeNull()
    act(() => handlers.get('instruction_detail')!({ detail: { session: 2, instruction: uncertain, body: 'Complete instruction beyond its preview' } }))
    expect(screen.getByText('Complete instruction beyond its preview').tagName).toBe('PRE')
    fireEvent.click(screen.getByRole('button', { name: 'Open pane' }))
    expect(onOpenPane).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel instruction' }))
    expect(methods.instructionCancel).toHaveBeenCalledExactlyOnceWith(2, 'uncertain-1')
    expect(methods.instructionResume).not.toHaveBeenCalled()
  })
})
