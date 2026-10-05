// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BrowserBlankState, BrowserUnreachableState } from './BrowserPaneStates'

const server = { port: 5173, process: 'vite', session: 8, pane_title: 'dev-server pane' }

describe('browser pane states', () => {
  it('shows local servers before recents and opens the selected port', () => {
    const onOpenServer = vi.fn()
    render(<BrowserBlankState recents={[{ url: 'http://localhost:6006/', onOpen: () => {} }]} servers={[server]} unsupported={null} truncated={false} onClear={() => {}} onOpenPage={() => {}} onOpenServer={onOpenServer} />)
    expect(screen.getByText('Enter a URL, or open a server this workspace is running.')).toBeTruthy()
    const order = screen.getByText('Local servers').compareDocumentPosition(screen.getByText('Recently opened'))
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const row = screen.getByRole('button', { name: /localhost:5173/ })
    expect(row.className).toContain('bg-transparent')
    expect(screen.getByText('vite · dev-server pane').className).toContain('font-normal')
    expect(screen.getByTestId('browser-pane-open-cta').className).toContain('bg-transparent')
    expect(screen.getByTestId('browser-pane-clear-recents').className).toContain('uppercase')
    fireEvent.click(row)
    expect(onOpenServer).toHaveBeenCalledWith('http://localhost:5173/')
  })

  it('retries and reveals raw failure details', () => {
    const onRetry = vi.fn()
    const onToggleDetails = vi.fn()
    render(<BrowserUnreachableState host="localhost:8080" message="Nothing is listening on port 8080. Start the server, then retry." rawError="ERR_CONNECTION_REFUSED" url="http://localhost:8080/" attempts={2} details={false} onRetry={onRetry} onToggleDetails={onToggleDetails} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onToggleDetails).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Show details' }).className).toContain('uppercase')
    const tile = screen.getByRole('alert').querySelector('[data-testid="icon-tile"]')!
    expect(tile.className).toContain('border-[color-mix(in_srgb,var(--status-blocked-text)_35%,transparent)]')
    expect(tile.className).toContain('bg-[var(--status-blocked-bg)]')
  })
})
