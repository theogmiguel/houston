// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, MergeQueueSettings } from '../../houston/client'
import { MergeQueueSettingsSection } from './MergeQueueSettingsSection'

type Handler = (message: unknown) => void

function fakeClient(): { client: HoustonClient; emit: (message: Record<string, unknown>) => void; set: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } {
  const handlers = new Map<string, Set<Handler>>()
  let request = 0
  const set = vi.fn(() => ++request)
  const pause = vi.fn(() => ++request)
  const client = {
    subscribe: (kind: string, handler: Handler) => {
      const bucket = handlers.get(kind) ?? new Set<Handler>()
      handlers.set(kind, bucket)
      bucket.add(handler)
      return () => bucket.delete(handler)
    },
    mergeQueueGet: vi.fn(),
    mergeQueueSettingsSet: set,
    mergeQueuePause: pause,
    mergeQueuePauseAll: pause
  } as unknown as HoustonClient
  const emit = (message: Record<string, unknown>): void => {
    for (const handler of handlers.get(message.type as string) ?? []) handler(message)
  }
  return { client, emit, set, pause }
}

function snapshot(settings: MergeQueueSettings): Record<string, unknown> {
  return { type: 'merge_queue', workspace: '/repo', dir: '/repo', entries: [], log: [], settings, global_paused: false, away: { merged: 0, parked: 0, last_merge_at_ms: null }, message: null }
}

afterEach(cleanup)

describe('Settings ▸ Workspaces ▸ Merge queue', () => {
  it('keeps the policy off until a command is set, and says why', () => {
    const { client, emit, set } = fakeClient()
    render(<MergeQueueSettingsSection client={client} workspace="/repo" />)
    act(() => emit(snapshot({ merge_when_verified: false, verification_command: '', time_limit_minutes: 30, paused: false })))
    expect(screen.getByText('Set a verification command to turn this on.')).toBeTruthy()
    const policy = screen.getByTestId('merge-queue-policy-switch') as HTMLButtonElement
    expect(policy.disabled).toBe(true)

    const command = screen.getByTestId('merge-queue-command') as HTMLInputElement
    fireEvent.change(command, { target: { value: 'cargo nextest run' } })
    fireEvent.blur(command)
    expect(set).toHaveBeenCalledWith('/repo', false, 'cargo nextest run', 30)
  })

  it('shows each current value: the command, the limit and the queue state', () => {
    const { client, emit, pause } = fakeClient()
    render(<MergeQueueSettingsSection client={client} workspace="/repo" />)
    act(() => emit(snapshot({ merge_when_verified: true, verification_command: 'cargo test', time_limit_minutes: 45, paused: true })))
    expect((screen.getByTestId('merge-queue-command') as HTMLInputElement).value).toBe('cargo test')
    expect((screen.getByTestId('merge-queue-time-limit') as HTMLInputElement).value).toBe('45')
    expect(screen.getByText('Paused')).toBeTruthy()
    fireEvent.click(screen.getByTestId('merge-queue-settings-pause'))
    expect(pause).toHaveBeenCalledWith('/repo', false)
    fireEvent.click(screen.getByTestId('merge-queue-pause-all'))
    expect(pause).toHaveBeenLastCalledWith(true)
  })

  it('shows the daemon’s refusal by name', () => {
    const { client, emit, set } = fakeClient()
    render(<MergeQueueSettingsSection client={client} workspace="/repo" />)
    act(() => emit(snapshot({ merge_when_verified: false, verification_command: 'cargo test', time_limit_minutes: 30, paused: false })))
    fireEvent.click(screen.getByTestId('merge-queue-policy-switch'))
    expect(set).toHaveBeenCalledWith('/repo', true, 'cargo test', 30)
    act(() => emit({ type: 'merge_queue_reply', dir: '/repo', request: 1, number: 0, ok: false, message: 'Merge when verified needs a Verification command' }))
    expect(screen.getByTestId('merge-queue-settings-refusal').textContent).toContain('needs a Verification command')
  })
})
