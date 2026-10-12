// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { RemoteSection } from '../src/components/settings/RemoteSection'
import type { RemoteInfo } from '../src/houston/generated/RemoteInfo'
import { remoteClient, SettingsRemote } from './settingsStories'
import { HarnessPageStory } from './navStories'

afterEach(cleanup)
const remote: RemoteInfo = { enabled: false, listening: false, bind: '127.0.0.1:47823', public_url: 'https://box.ts.net', url: 'https://box.ts.net', error: null, ntfy_server: null, notify_delay_secs: 30, notify_detail: 'generic', notify_finished: false, dictation: false, tls: false, ca_fingerprint: null, devices: [] }
it('lets the Remote fixture enable its listener, show an inline code and retain subscriptions', async () => {
  render(<RemoteSection client={remoteClient(remote)} onChangeRoute={() => {}} />)
  await act(async () => { await Promise.resolve() })
  fireEvent.click(screen.getByTestId('settings-remote-connect-phone'))
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('img', { name: 'Pairing code' })).toBeTruthy()
  expect(screen.getByTestId('settings-remote-status').textContent).toBe('Listening at https://box.ts.net')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([
  ['Review', () => <HarnessPageStory inSettings />],
  ['Remote pairing', () => <SettingsRemote pairing />]
])('shows the shared navigation attention fixture in %s', async (_name, story) => {
  render(story())
  await act(async () => { await Promise.resolve() })
  for (const [label, count] of [['Overview', '3'], ['CLIs', '1'], ['MCP servers', '1'], ['Review', '1']]) {
    const row = within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: new RegExp(`^${label}`) })
    expect(row.textContent).toContain(count)
  }
  expect(screen.getByLabelText('Settings, 3 agent settings need you')).toBeTruthy()
})
