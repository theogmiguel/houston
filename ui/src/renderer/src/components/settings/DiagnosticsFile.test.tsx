// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ClientMsg } from '../../houston/generated/ClientMsg'
import type { ServerMsg } from '../../houston/generated/ServerMsg'

const shown = vi.hoisted(() => [] as string[])
vi.mock('../../houston/bridge', () => ({
  showItemInFolder: async (path: string) => {
    shown.push(path)
    return { ok: true, error: null }
  }
}))
import { DiagnosticsFileRow, folderOf } from './DiagnosticsFile'

beforeAll(() => {
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'
})
afterEach(() => {
  cleanup()
  shown.length = 0
})

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

it('asks once with the app version, then names the file and opens its folder', () => {
  const { client, sent, emit } = fakeClient()
  render(<DiagnosticsFileRow client={client} />)
  fireEvent.click(screen.getByTestId('settings-diagnostics-file'))
  expect(sent).toEqual([{ type: 'diagnostics_collect', app_version: '0.0.0-test' }])
  expect((screen.getByTestId('settings-diagnostics-file') as HTMLButtonElement).disabled).toBe(true)
  emit({ type: 'diagnostics_collected', path: '/home/u/.houston/diagnostics/houston-diagnostics-x.txt', bytes: 2048, error: null })
  expect(screen.getByTestId('settings-diagnostics-file-desc').textContent).toBe(
    'Saved /home/u/.houston/diagnostics/houston-diagnostics-x.txt (2.0 KB). Read it before attaching it to an issue.'
  )
  fireEvent.click(screen.getByText('Show folder'))
  expect(shown).toEqual(['/home/u/.houston/diagnostics'])
})

it('shows the daemon error when no file was written', () => {
  const { client, emit } = fakeClient()
  render(<DiagnosticsFileRow client={client} />)
  fireEvent.click(screen.getByTestId('settings-diagnostics-file'))
  emit({ type: 'diagnostics_collected', path: null, bytes: 0, error: 'writing /s/diagnostics/f.txt: disk full' })
  expect(screen.getByTestId('settings-diagnostics-file-desc').textContent).toBe(
    'No file was written: writing /s/diagnostics/f.txt: disk full'
  )
  expect(screen.queryByText('Show folder')).toBeNull()
})

it('takes the folder of Windows and Unix paths', () => {
  expect(folderOf('C:\\Users\\u\\.houston\\diagnostics\\f.txt')).toBe('C:\\Users\\u\\.houston\\diagnostics')
  expect(folderOf('/home/u/.houston/diagnostics/f.txt')).toBe('/home/u/.houston/diagnostics')
})
