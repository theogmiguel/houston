// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ClientMsg } from '../../houston/generated/ClientMsg'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { hostInfoFixture } from '../settingsViewTestFixtures'
import { RECLAIM_HINT_BYTES, StorageDiagnostics } from './StorageDiagnostics'

afterEach(cleanup)

function fakeClient(): { client: HoustonClient; sent: ClientMsg[]; emit: (msg: ServerMsg) => void } {
  const handlers = new Set<(msg: ServerMsg) => void>()
  const sent: ClientMsg[] = []
  const client = {
    subscribeAll(handler: (msg: ServerMsg) => void) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    send(msg: ClientMsg) {
      sent.push(msg)
    }
  } as unknown as HoustonClient
  return { client, sent, emit: (msg) => act(() => handlers.forEach((handler) => handler(msg))) }
}

it('shows every storage total and refuses the reclaim while sessions are live', () => {
  const { client, sent } = fakeClient()
  render(<StorageDiagnostics hostInfo={hostInfoFixture({ live_sessions: 2 })} client={client} />)
  const grid = screen.getByTestId('settings-diagnostics-storage').textContent ?? ''
  for (const label of ['Session database', 'Write-ahead log', 'Reclaimable', 'Scrollback', 'Logs']) {
    expect(grid).toContain(label)
  }
  expect(grid).toContain('6.0 MB')
  expect(screen.getByText(/Close or sleep all 2 live sessions first/)).toBeTruthy()
  const button = screen.getByTestId('settings-storage-reclaim') as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(sent).toEqual([])
})

it('sends one reclaim on click and reports the before and after sizes', () => {
  const { client, sent, emit } = fakeClient()
  render(<StorageDiagnostics hostInfo={hostInfoFixture({ live_sessions: 0 })} client={client} />)
  fireEvent.click(screen.getByTestId('settings-storage-reclaim'))
  expect(sent).toEqual([{ type: 'storage_reclaim' }])
  expect(screen.getByTestId('settings-storage-reclaim').textContent).toBe('Reclaiming…')
  emit({ type: 'storage_reclaimed', before_bytes: 3 * 1024 * 1024, after_bytes: 1024 * 1024, refusal: null })
  expect(screen.getByTestId('settings-storage-result').textContent).toBe(
    'Reclaimed 2.0 MB: the session database went from 3.0 MB to 1.0 MB.'
  )
  expect(screen.getByTestId('settings-storage-reclaim').textContent).toBe('Reclaim space')
})

it('shows the daemon refusal as it was worded', () => {
  const { client, emit } = fakeClient()
  render(<StorageDiagnostics hostInfo={hostInfoFixture({ live_sessions: 0 })} client={client} />)
  fireEvent.click(screen.getByTestId('settings-storage-reclaim'))
  const reason = 'refused: 99 bytes free at /state; reclaiming space needs at least the database size, 100 bytes'
  emit({ type: 'storage_reclaimed', before_bytes: 100, after_bytes: 100, refusal: reason })
  expect(screen.getByTestId('settings-storage-result').textContent).toBe(reason)
})

it('hints at reclaiming only when the free space reaches the hint threshold', () => {
  const { client } = fakeClient()
  const { rerender } = render(
    <StorageDiagnostics hostInfo={hostInfoFixture({ session_db_free_bytes: RECLAIM_HINT_BYTES - 1 })} client={client} />
  )
  expect(screen.queryByTestId('settings-storage-hint')).toBeNull()
  rerender(<StorageDiagnostics hostInfo={hostInfoFixture({ session_db_free_bytes: RECLAIM_HINT_BYTES })} client={client} />)
  expect(screen.getByTestId('settings-storage-hint').textContent).toContain('32.0 MB')
})
