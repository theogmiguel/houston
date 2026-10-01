// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceControlPanel } from './SourceControlPanel'
import type { HoustonClient } from '../houston/client'
const saveReview = vi.hoisted(() => vi.fn().mockResolvedValue('/tmp/review.md'))
vi.mock('../houston/bridge', () => ({ saveReview }))
vi.mock('./ChangesPane', () => ({ ChangesPane: () => <div /> }))
vi.mock('./git/PullRequestTab', () => ({ PullRequestTab: () => <div /> }))
afterEach(cleanup)
describe('child checkout review', () => {
  it('reuses the safe review packet and pastes comments into the selected child', async () => {
    let receive!: (message: unknown) => void
    const gitReviewDiffs = vi.fn(), sendStdin = vi.fn().mockReturnValue(true), onReviewPacket = vi.fn()
    const client = { subscribe: (_type: string, callback: (message: unknown) => void) => { receive = callback; return () => {} }, gitReviewDiffs, sendStdin } as unknown as HoustonClient
    render(<SourceControlPanel dir="/child" client={client} width={432} onWidth={vi.fn()} onResetWidth={vi.fn()} tab="changes" onTab={vi.fn()} reviewTarget={9} onReviewPacket={onReviewPacket} embedded />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Diff comments' }), { target: { value: 'Handle the empty state.' } })
    fireEvent.click(screen.getByText('Send comments to child'))
    expect(gitReviewDiffs).toHaveBeenCalledWith('/child')
    const packet = { dir: '/child', branch: 'fix', upstream: null, ahead: 0, behind: 0, head: null, files: [], sections: [{ scope: 'unstaged', patch: 'diff --git a/a b/a\n+changed' }], blocked_paths: [], warnings: [], truncated: false, redacted: false }
    act(() => receive(packet))
    await waitFor(() => expect(sendStdin).toHaveBeenCalled())
    expect(saveReview).toHaveBeenCalledWith(expect.stringContaining('Handle the empty state.'))
    expect(onReviewPacket).toHaveBeenCalledWith(packet)
    expect(sendStdin).toHaveBeenCalledWith(9, expect.stringMatching(/^\x1b\[200~.*review\.md.*\x1b\[201~$/s))
  })
})
