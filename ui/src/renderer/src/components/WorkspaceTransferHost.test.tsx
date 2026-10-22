// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HoustonClient } from '../houston/client'
import { openWorkspaceTransfer } from '../houston/transferOpen'
import { WorkspaceTransferHost } from './WorkspaceTransferHost'

afterEach(cleanup)

const client = { subscribeAll: () => () => {}, send: () => {} } as unknown as HoustonClient

describe('workspace transfer host', () => {
  it('keeps what the user typed when the host re-renders after the dialog loads', { timeout: 30000 }, async () => {
    const view = render(<WorkspaceTransferHost client={client} workspaces={[]} profiles={[]} onImported={() => {}} />)
    act(() => openWorkspaceTransfer({ mode: 'export', workspace: '/w', name: 'w' }))
    const input = (await screen.findByLabelText('Passphrase', {}, { timeout: 20000 })) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'secret' } })
    view.rerender(<WorkspaceTransferHost client={client} workspaces={[{ path: '/w', name: 'w' }]} profiles={[]} onImported={() => {}} />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect((screen.getByLabelText('Passphrase') as HTMLInputElement).value).toBe('secret')
  })
})
