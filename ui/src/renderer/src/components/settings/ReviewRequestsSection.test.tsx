// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { ReviewRequestsSection } from './ReviewRequestsSection'

function fakeClient(sent: string[]) {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const emit = (msg: ServerMsg): void => {
    handlers.get(msg.type)?.forEach((handler) => handler(msg))
  }
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    reviewRequestsGet: () => emit({ type: 'review_requests', mode: 'off', items: [], paused_until_ms: null, note: null }),
    reviewRequestsSet: (mode: string) => { sent.push(mode); emit({ type: 'review_requests', mode: mode as 'notify', items: [], paused_until_ms: null, note: null }) }
  }
  return { client: client as unknown as HoustonClient, emit }
}

describe('Settings ▸ Workspaces ▸ Review requests', () => {
  afterEach(cleanup)

  it('shows the current mode and explains all three states', async () => {
    const sent: string[] = []
    const { client } = fakeClient(sent)
    render(<ReviewRequestsSection client={client} />)
    expect(await screen.findByText('Currently Off')).toBeTruthy()
    expect(screen.getByText(/Off: nothing is requested/)).toBeTruthy()
    expect(screen.getByText(/Notify: every 2 minutes Houston asks GitHub/)).toBeTruthy()
    expect(screen.getByText(/Review: additionally starts a read-only review pane/)).toBeTruthy()

    act(() => screen.getByTestId('settings-review-requests-notify').click())
    expect(sent).toEqual(['notify'])
    expect(await screen.findByText('Currently Notify')).toBeTruthy()
  })

  it('shows a pause and a credential note in place', () => {
    const { client, emit } = fakeClient([])
    render(<ReviewRequestsSection client={client} />)
    act(() => emit({ type: 'review_requests', mode: 'notify', items: [], paused_until_ms: Date.UTC(2026, 9, 25, 12, 5), note: 'The GitHub token expired.' }))
    expect(screen.getByTestId('settings-review-requests-paused').textContent).toContain('GitHub asked Houston to wait until')
    expect(screen.getByTestId('settings-review-requests-note').textContent).toContain('The GitHub token expired.')
  })
})
