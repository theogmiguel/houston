// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../houston/client'
import type { ClientMsg } from '../houston/generated/ClientMsg'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import type { TransferFileSummary } from '../houston/generated/TransferFileSummary'
import { ExportTransferDialog, ImportTransferDialog, TransferRefusalView } from './WorkspaceTransferDialog'

const { picked } = vi.hoisted(() => ({ picked: vi.fn<() => Promise<string | null>>() }))
vi.mock('../houston/transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../houston/transfer')>()),
  pickTransferDestination: picked
}))

afterEach(() => {
  cleanup()
  picked.mockReset()
})

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
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'correct-horse' } })
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'wrong-horse' } })
    expect(screen.getByRole('alert').textContent).toBe('The passphrases differ.')
    expect((exportButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'correct-horse' } })
    expect((exportButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('export says the minimum passphrase length and waits for it', () => {
    const { client } = fakeClient()
    render(<ExportTransferDialog client={client} workspace="/w" name="w" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'short' } })
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'short' } })
    expect(screen.getByRole('alert').textContent).toBe('The passphrase has 5 characters; at least 12 are required.')
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'correct-horse' } })
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'correct-horse' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false)
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

  it("import keeps the workspace it was opened from, even when another one has the file's remote", async () => {
    const { client, sent, emit } = fakeClient()
    const targets = [{ path: '/home/b/other', name: 'other' }, { path: '/home/b/project', name: 'project' }]
    render(<ImportTransferDialog client={client} targets={targets} profiles={[]} initialWorkspace="/home/b/other" initialFile="/tmp/t.houston-transfer" onImported={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const inspect = sent.find((msg) => msg.type === 'transfer_inspect')
    if (inspect?.type !== 'transfer_inspect') throw new Error('no inspect request')
    await emit({ type: 'transfer_inspected', request: inspect.request, summary })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(sent.find((msg) => msg.type === 'transfer_import')).toMatchObject({ workspace: '/home/b/other' })
  })

  it('export adds the extension and replaces only the file the save dialog confirmed', async () => {
    const { client, sent } = fakeClient()
    picked.mockResolvedValueOnce('/tmp/w')
    render(<ExportTransferDialog client={client} workspace="/w" name="w" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'correct-horse' } })
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'correct-horse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await vi.waitFor(() => expect(sent.some((msg) => msg.type === 'transfer_export')).toBe(true))
    expect(sent[0]).toMatchObject({ destination: '/tmp/w.houston-transfer', overwrite: false })
  })

  it('export refusal: Back returns to the form with the passphrase, Close closes', async () => {
    const { client, sent, emit } = fakeClient()
    const onClose = vi.fn()
    picked.mockResolvedValue('/tmp/w.houston-transfer')
    render(<ExportTransferDialog client={client} workspace="/w" name="w" onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'correct-horse' } })
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'correct-horse' } })
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await vi.waitFor(() => expect(sent.some((msg) => msg.type === 'transfer_export')).toBe(true))
    const request = sent[0].type === 'transfer_export' ? sent[0].request : -1
    expect(sent[0]).toMatchObject({ overwrite: true })
    await emit({ type: 'transfer_refused', request, refusal: { code: 'busy_panes', problem: '1 pane is still busy.', items: ['api (pane 4): working'], steps: ['Let it finish.'] } })
    expect(screen.getByText('1 pane is still busy.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect((screen.getByLabelText('Passphrase') as HTMLInputElement).value).toBe('correct-horse')
    expect((screen.getByLabelText('Repeat') as HTMLInputElement).value).toBe('correct-horse')
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await vi.waitFor(() => expect(sent.filter((msg) => msg.type === 'transfer_export')).toHaveLength(2))
    const again = sent[1].type === 'transfer_export' ? sent[1].request : -1
    await emit({ type: 'transfer_refused', request: again, refusal: { code: 'busy_panes', problem: 'Still busy.', items: [], steps: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('import refusal: Back keeps the file, passphrase and profile choices, Close closes', async () => {
    const { client, sent, emit } = fakeClient()
    const onClose = vi.fn()
    const targets = [{ path: '/home/b/project', name: 'project' }]
    render(<ImportTransferDialog client={client} targets={targets} profiles={[]} initialFile="/tmp/t.houston-transfer" onImported={() => {}} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const inspect = sent.find((msg) => msg.type === 'transfer_inspect')
    if (inspect?.type !== 'transfer_inspect') throw new Error('no inspect request')
    await emit({ type: 'transfer_inspected', request: inspect.request, summary })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    const first = sent.filter((msg) => msg.type === 'transfer_import')
    expect(first).toHaveLength(1)
    if (first[0].type !== 'transfer_import') return
    await emit({ type: 'transfer_refused', request: first[0].request, refusal: { code: 'dirty_checkout', problem: '/home/b/project has uncommitted changes.', items: ['README.md'], steps: ['Commit them.'] } })
    expect(screen.getByText('/home/b/project has uncommitted changes.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    const second = sent.filter((msg) => msg.type === 'transfer_import')
    expect(second).toHaveLength(2)
    expect(second[1]).toMatchObject({ path: '/tmp/t.houston-transfer', passphrase: 'secret', workspace: '/home/b/project', profiles: first[0].profiles })
    if (second[1].type !== 'transfer_import') return
    await emit({ type: 'transfer_refused', request: second[1].request, refusal: { code: 'dirty_checkout', problem: 'Still dirty.', items: [], steps: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
