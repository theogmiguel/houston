// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HAND_OFF_AGENTS, handOffDefault, MergeQueueHandOffPicker } from './MergeQueueHandOffPicker'

afterEach(cleanup)

describe('MergeQueueHandOffPicker', () => {
  it('offers only spawnable coding agents, never a shell', () => {
    expect(HAND_OFF_AGENTS).toEqual(['claude', 'codex', 'antigravity', 'opencode', 'zcode'])
    render(<MergeQueueHandOffPicker busy={false} onOpen={vi.fn()} onCancel={vi.fn()} />)
    const offered = screen.getAllByRole('button', { pressed: undefined }).map((b) => b.getAttribute('data-agent')).filter(Boolean)
    expect(offered).toEqual([...HAND_OFF_AGENTS])
  })

  it('preselects the workspace’s default agent and opens the pane with the one picked', () => {
    const onOpen = vi.fn()
    render(<MergeQueueHandOffPicker defaultAgent="codex" busy={false} onOpen={onOpen} onCancel={vi.fn()} />)
    expect(screen.getByTestId('merge-queue-hand-off-codex').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('merge-queue-hand-off-claude').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByTestId('merge-queue-hand-off-opencode'))
    fireEvent.click(screen.getByTestId('merge-queue-hand-off-open'))
    expect(onOpen).toHaveBeenCalledWith('opencode')
  })

  it('falls back to Claude Code when the default is not spawnable, and cancels without opening', () => {
    expect(handOffDefault('shell')).toBe('claude')
    expect(handOffDefault(null)).toBe('claude')
    const onOpen = vi.fn()
    const onCancel = vi.fn()
    render(<MergeQueueHandOffPicker defaultAgent="shell" busy={false} onOpen={onOpen} onCancel={onCancel} />)
    expect(screen.getByTestId('merge-queue-hand-off-claude').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })
})
