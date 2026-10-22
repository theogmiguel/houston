// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../houston/client'
import type { ClientMsg } from '../houston/generated/ClientMsg'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import type { TransferFileSummary } from '../houston/generated/TransferFileSummary'
import { ExportTransferDialog, ImportTransferDialog, TransferRefusalView } from './WorkspaceTransferDialog'

afterEach(cleanup)

function fakeClient() {
  const handlers = new Set<(msg: ServerMsg) => void>()
  const sent: ClientMsg[] = []
  const client = {
    subscribeAll: (handler: (msg: ServerMsg) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    send: (msg: ClientMsg) => sent.push(msg)
  }
  const emit = async (msg: ServerMsg): Promise<void> => {
    await act(async () => {
      for (const handler of [...handlers]) handler(msg)
    })
  }
  return { client: client as unknown as HoustonClient, sent, emit }
}

const summary: TransferFileSummary = {
  transfer_id: 't1',
  source_os: 'linux',
  source_workspace: '/home/a/project',
  remote_url: 'git@github.com:o/r.git',
  created_at_ms: 0,
  panes: [{ session: 4, title: 'api', provider: 'claude', checkout: 'main checkout', profile_label: 'work' }],
  skipped: [{ session: 5, title: 'zsh', reason: 'shell pane' }],
  cli_versions: [{ provider: 'claude', version: '2.1.307' }],
  proposed_workspace: '/home/b/project',
  profiles: [{ provider: 'claude', label: 'work', matched: false }],
  return_trip: false
}

describe('workspace transfer dialogs', () => {
  it('shows a refusal as the problem, the exact items and the steps', () => {
    render(<TransferRefusalView refusal={{ code: 'dirty_checkout', problem: '/w has uncommitted changes.', items: ['README.md'], steps: ['Commit them, then import again.'] }} />)
    expect(screen.getByText('/w has uncommitted changes.')).toBeTruthy()
    expect(screen.getAllByRole('listitem')[0].textContent).toBe('README.md')
    expect(screen.getByText('Commit them, then import again.')).toBeTruthy()
  })

  it('export waits for the passphrase twice', () => {
    const { client } = fakeClient()
    render(<ExportTransferDialog client={client} workspace="/w" name="w" onClose={() => {}} />)
    const exportButton = screen.getByRole('button', { name: 'Export' })
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'one' } })
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'two' } })
    expect(screen.getByRole('alert').textContent).toBe('The passphrases differ.')
    expect((exportButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'one' } })
    expect((exportButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('import reads the summary, proposes the matching workspace and sends the profile choice', async () => {
    const { client, sent, emit } = fakeClient()
    const onImported = vi.fn()
    const targets = [{ path: '/home/b/other', name: 'other' }, { path: '/home/b/project', name: 'project' }]
    render(<ImportTransferDialog client={client} targets={targets} profiles={[]} initialFile="/tmp/t.houston-transfer" onImported={onImported} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const inspect = sent.find((msg) => msg.type === 'transfer_inspect')
    expect(inspect).toMatchObject({ path: '/tmp/t.houston-transfer', passphrase: 'secret' })
    if (inspect?.type !== 'transfer_inspect') return
    await emit({ type: 'transfer_inspected', request: inspect.request, summary })
    expect(screen.getByText('zsh: shell pane')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    const imported = sent.find((msg) => msg.type === 'transfer_import')
    expect(imported).toMatchObject({
      workspace: '/home/b/project',
      profiles: [{ provider: 'claude', label: 'work', use_profile: null }]
    })
    if (imported?.type !== 'transfer_import') return
    const result = { transfer_id: 't1', workspace: '/home/b/project', source_workspace: '/home/a/project', sessions: [{ from: 4, to: 40 }], updated_in_place: [], grids: '{}' }
    await emit({ type: 'transfer_imported', request: imported.request, result })
    expect(onImported).toHaveBeenCalledWith(result, '/home/b/project')
    expect(screen.getByText(/resumed 1 pane/)).toBeTruthy()
  })
})
