// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceDefaultsSection } from './WorkspaceDefaultsSection'
import { hostInfoFixture, setInputValue } from '../settingsViewTestFixtures'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

describe('WorkspaceDefaultsSection', () => {
  it('worktree cleanup settings', () => {
    const onWorktreeCleanupSet = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root!.render(
        <WorkspaceDefaultsSection
          onRestoreBudgetSet={() => {}}
          onRestoreResumeSet={() => {}}
          onWorktreeCleanupSet={onWorktreeCleanupSet}
          openLinksInPane={false}
          onOpenLinksInPane={() => {}}
          historyWorkspace={null}
          historyWorkspaceName={null}
          hostInfo={hostInfoFixture({ worktree_cleanup_enabled: false, worktree_cleanup_grace_hours: 24 })}
          sessionPolicy={null}
          onSessionPolicy={() => {}}
        />
      )
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Remove merged worktrees automatically')
    expect(text).toContain('Grace after merge')
    expect(text).toContain('1 to 720 h')

    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="worktree-cleanup-switch"]')!.click()
    })
    expect(onWorktreeCleanupSet).toHaveBeenLastCalledWith(true, 24)

    const grace = document.querySelector<HTMLInputElement>('[data-testid="settings-worktree-cleanup-grace"]')!
    expect(grace.min).toBe('1')
    expect(grace.max).toBe('720')
    act(() => {
      setInputValue(grace, '48')
      grace.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onWorktreeCleanupSet).toHaveBeenLastCalledWith(false, 48)
  })
})
