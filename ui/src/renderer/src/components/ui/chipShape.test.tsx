// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Chip } from './Chip'
import { CopyChip } from './CopyChip'
import { ShellBranchCopyChip } from './ShellPrimitives'
import { PaneStateChip } from './PaneControls'
import { TagChip } from './TagChip'
import { PullRequestLabel } from './PullRequestLabel'
import { PullRequestState } from './PullRequestState'

afterEach(cleanup)
it('uses capsules for chip actions and rounded corners for values', () => {
  render(<><Chip variant="choice" label="Choice action" onClick={() => {}} /><Chip variant="state" label="Status value" /><CopyChip value="checkout">Copy checkout</CopyChip><ShellBranchCopyChip value="main">main</ShellBranchCopyChip><PaneStateChip state="exited">Exited</PaneStateChip><TagChip tag={{ id: 1, name: 'Static tag', color: '#aabbcc' }} /><TagChip tag={{ id: 2, name: 'Filter tag', color: '#aabbcc' }} onToggle={() => {}} /><PullRequestLabel>bug</PullRequestLabel><PullRequestState state="open">Open</PullRequestState></>)
  for (const name of ['Choice action', 'Copy checkout', 'main', 'Filter tag']) expect(screen.getByText(name).closest('button')?.className).toContain('rounded-[var(--tr-radius-pill)]')
  for (const name of ['Status value', 'Exited', 'Static tag', 'bug', 'Open']) {
    const element = name === 'Status value' ? screen.getByText(name).closest('[data-testid="chip"]') : name === 'Static tag' ? screen.getByText(name).closest('[data-testid="tag-chip"]') : screen.getByText(name)
    expect(element?.className).toContain('rounded-[var(--tr-radius-sm)]')
    expect(element?.className).not.toContain('rounded-full')
  }
})
