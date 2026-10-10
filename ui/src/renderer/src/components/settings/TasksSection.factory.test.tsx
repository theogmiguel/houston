// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientMsg, HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { TasksSection } from './TasksSection'

function fakeClient(): { client: HoustonClient; sent: ClientMsg[]; emit: (message: ServerMsg) => void } {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  const sent: ClientMsg[] = []
  const known = {
    subscribe: (type: string, handler: (message: ServerMsg) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => handlers.get(type)?.delete(handler)
    },
    subscribeAll: () => () => {},
    send: (message: ClientMsg) => sent.push(message)
  }
  // Every other client call this section makes is a request the test does not answer.
  const client = new Proxy(known, { get: (target, key) => key in target ? target[key as keyof typeof target] : key === 'then' ? undefined : () => {} }) as unknown as HoustonClient
  return { client, sent, emit: (message) => handlers.get(message.type)?.forEach((handler) => handler(message)) }
}

describe('Settings ▸ Tasks ▸ Factory', () => {
  afterEach(cleanup)

  it('shows the current limits and saves a change through factory_settings_set', () => {
    const { client, sent, emit } = fakeClient()
    render(<TasksSection client={client} workspace={null} />)
    expect(sent).toContainEqual({ type: 'factory_settings_get' })
    const live = screen.getByRole('spinbutton', { name: 'Live task runs' }) as HTMLInputElement
    expect(live.disabled).toBe(true)

    act(() => emit({ type: 'factory_settings', live_runs_max: 3, needs_you_max: 4, live_runs: 1, needs_you: 2 }))
    expect(live.value).toBe('3')
    expect((screen.getByRole('spinbutton', { name: 'Needs-you items before automatic starts pause' }) as HTMLInputElement).value).toBe('4')
    expect(screen.getByTestId('settings-factory-live-runs-current').textContent).toBe('Currently 3 · 1 live now')
    expect(screen.getByTestId('settings-factory-needs-you-current').textContent).toBe('Currently 4 · 2 waiting now')

    fireEvent.change(live, { target: { value: '5' } })
    fireEvent.blur(live)
    expect(sent.at(-1)).toEqual({ type: 'factory_settings_set', live_runs_max: 5, needs_you_max: 4 })
  })

  it('refuses an out-of-range value locally and shows the daemon refusal', () => {
    const { client, sent, emit } = fakeClient()
    render(<TasksSection client={client} workspace={null} />)
    act(() => emit({ type: 'factory_settings', live_runs_max: 3, needs_you_max: 3, live_runs: 0, needs_you: 0 }))
    const needsYou = screen.getByRole('spinbutton', { name: 'Needs-you items before automatic starts pause' }) as HTMLInputElement
    const before = sent.length
    fireEvent.change(needsYou, { target: { value: '17' } })
    fireEvent.blur(needsYou)
    expect(sent.length).toBe(before)
    expect(screen.getByTestId('settings-factory-needs-you-rejected').textContent).toContain('between 1 and 16')
    expect(needsYou.value).toBe('3')

    fireEvent.change(needsYou, { target: { value: '6' } })
    fireEvent.blur(needsYou)
    expect(sent.at(-1)).toEqual({ type: 'factory_settings_set', live_runs_max: 3, needs_you_max: 6 })
    act(() => emit({ type: 'task_refused', id: null, kind: 'invalid', message: 'needs_you_max 6 exceeds the cap of 4', limit: 4, requested: 6, expected: null, actual: null }))
    expect(screen.getByTestId('settings-factory-refusal').textContent).toBe('needs_you_max 6 exceeds the cap of 4')
  })
})
