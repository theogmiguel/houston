// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeRemoveConfirm } from './WorktreeRemoveConfirm'
import { WorktreesDialog } from './WorktreesDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const worktree = { path: '/repo/.houston/worktrees/x', branch: 'houston/x', head: 'abcdef1234567890', is_main: false, is_detached: false, is_bare: false, dirty: false }

let host: HTMLElement | null = null
let root: Root | null = null

// A popover with a backdrop filter is the containing block of a fixed descendant, so a
// dialog rendered inside it is centred in the popover's box and clipped by the viewport.
function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div')
  host.style.backdropFilter = 'blur(16px)'
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

describe('git dialogs mount outside the surface that opens them', () => {
  it('the Worktrees dialog is a child of document.body, not of its host', () => {
    const container = mount(
      <WorktreesDialog dir="/repo" worktrees={[worktree]} cleanup={{ status: 'pending' }} removeCheck={null} branches={[]} defaultBranch="main" busy={false} error={null}
        onClose={vi.fn()} onRefresh={vi.fn()} onCreate={vi.fn()} onCheckRemove={vi.fn()} onRemove={vi.fn()} onPrune={vi.fn()} onCheckCleanup={vi.fn()} onCleanNow={vi.fn()} onRemoveStale={vi.fn()} onAddWorkspace={vi.fn()} />
    )
    const dialog = document.querySelector('[data-testid="git-worktrees-dialog"]')
    expect(dialog, 'dialog rendered').not.toBeNull()
    expect(container.contains(dialog), 'dialog inside the filtered host').toBe(false)
  })

  it('the remove confirmation is a child of document.body, not of its host', () => {
    const container = mount(<WorktreeRemoveConfirm worktree={worktree} force={false} check={null} nowMs={0} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog, 'confirmation rendered').not.toBeNull()
    expect(container.contains(dialog), 'confirmation inside the filtered host').toBe(false)
  })
})
