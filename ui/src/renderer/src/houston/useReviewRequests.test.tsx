// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from './client'
import type { ServerMsg } from './generated/ServerMsg'
import { newReviewRequestCount, useReviewRequests } from './useReviewRequests'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ client }: { client: HoustonClient }): React.JSX.Element {
  const { state, setMode, dismiss, reopen } = useReviewRequests(client)
  return (
    <div>
      <output data-testid="mode">{state?.mode ?? 'loading'}</output>
      <output data-testid="count">{newReviewRequestCount(state)}</output>
      <button onClick={() => setMode('review')}>Set review</button>
      <button onClick={() => dismiss(2)}>Dismiss</button>
      <button onClick={() => reopen(2)}>Reopen</button>
    </div>
  )
}

describe('useReviewRequests', () => {
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

  it('reads the queue, follows broadcasts and sends the three decisions', () => {
    const handlers = new Map<string, (msg: ServerMsg) => void>()
    const client = {
      subscribe: vi.fn((kind: string, handler: (msg: ServerMsg) => void) => {
        handlers.set(kind, handler)
        return () => handlers.delete(kind)
      }),
      reviewRequestsGet: vi.fn(),
      reviewRequestsSet: vi.fn(),
      reviewRequestDismiss: vi.fn(),
      reviewRequestReopen: vi.fn()
    } as unknown as HoustonClient

    act(() => root.render(<Probe client={client} />))
    expect(client.reviewRequestsGet).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe('loading')

    act(() => handlers.get('review_requests')?.({
      type: 'review_requests',
      mode: 'notify',
      items: [
        { id: 1, host: 'github.com', repo: 'acme/houston', number: 1, title: 'One', author: 'a', url: 'u', head_sha: 's', tier: 'b', reasons: [], state: 'new', workspace: null, provider: null },
        { id: 2, host: 'github.com', repo: 'acme/houston', number: 2, title: 'Two', author: 'a', url: 'u', head_sha: 's', tier: 'c', reasons: [], state: 'dismissed', workspace: null, provider: null }
      ],
      paused_until_ms: null,
      note: null
    }))
    expect(container.querySelector('[data-testid="mode"]')?.textContent).toBe('notify')
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('1')

    act(() => handlers.get('review_requests')?.({
      type: 'review_requests', mode: 'off', items: [{ id: 1, host: 'github.com', repo: 'acme/houston', number: 1, title: 'One', author: 'a', url: 'u', head_sha: 's', tier: 'b', reasons: [], state: 'new', workspace: null, provider: null }], paused_until_ms: null, note: null
    }))
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe('0')

    act(() => (container.querySelectorAll('button')[0] as HTMLButtonElement).click())
    act(() => (container.querySelectorAll('button')[1] as HTMLButtonElement).click())
    act(() => (container.querySelectorAll('button')[2] as HTMLButtonElement).click())
    expect(client.reviewRequestsSet).toHaveBeenCalledWith('review')
    expect(client.reviewRequestDismiss).toHaveBeenCalledWith(2)
    expect(client.reviewRequestReopen).toHaveBeenCalledWith(2)
  })
})
