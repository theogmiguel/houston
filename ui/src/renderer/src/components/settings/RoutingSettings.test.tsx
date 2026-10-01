// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoutingSettings } from './RoutingSettings'
import type { HoustonClient } from '../../houston/client'
afterEach(cleanup)
describe('workspace routing settings', () => {
  it('loads current routes and edits, removes and saves the table through K2', () => {
    let receive!: (message: unknown) => void
    const workspaceRoutingGet = vi.fn(), workspaceRoutingSet = vi.fn()
    const client = { subscribe: (_type: string, callback: (message: unknown) => void) => { receive = callback; return () => {} }, workspaceRoutingGet, workspaceRoutingSet } as unknown as HoustonClient
    render(<RoutingSettings client={client} workspace="/work" />)
    expect(workspaceRoutingGet).toHaveBeenCalledWith('/work')
    act(() => receive({ workspace: '/work', routes: [{ pattern: 'ui*', model: 'model-a', effort: 'high' }] }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Model 1' }), { target: { value: 'model-b' } })
    fireEvent.click(screen.getByText('Save routing'))
    expect(workspaceRoutingSet).toHaveBeenCalledWith('/work', [{ pattern: 'ui*', model: 'model-b', effort: 'high' }])
    fireEvent.click(screen.getByRole('button', { name: 'Remove route 1' }))
    fireEvent.click(screen.getByText('Save routing'))
    expect(workspaceRoutingSet).toHaveBeenLastCalledWith('/work', [])
  })
  it('requires a selected workspace', () => {
    render(<RoutingSettings client={null} workspace={null} />)
    expect(screen.getByText('Select a workspace to edit its routing table.')).toBeTruthy()
  })
})
