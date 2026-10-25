import type { GitWorktreeInfo } from '../../houston/generated/GitWorktreeInfo'
import { ConfirmModal } from '../ConfirmModal'
import { Caption, Notice, Stack } from '../ui'
import { worktreeCheckFindings, worktreeRemoveConfirm, type WorktreeCheckView } from './worktrees'

export interface WorktreeRemoveConfirmProps {
  worktree: GitWorktreeInfo
  force: boolean
  check: WorktreeCheckView | null
  nowMs: number
  onConfirm: () => void
  onCancel: () => void
}

// Confirm waits for the daemon's check, so what the removal would interrupt or lose is
// on screen before it can proceed.
export function WorktreeRemoveConfirm({ worktree, force, check, nowMs, onConfirm, onCancel }: WorktreeRemoveConfirmProps): React.JSX.Element {
  const ready = check?.path === worktree.path && check.status === 'ready' ? check.check : null
  const findings = ready ? worktreeCheckFindings(ready, nowMs) : []
  const details = ready === null
    ? <Caption tone="faint">Checking what this removal would interrupt or lose…</Caption>
    : findings.length === 0
      ? <Caption>No uncommitted changes, unpushed commits or open panes found.</Caption>
      : <Notice tone="warn" data-testid="worktree-check-findings"><Stack gap={0}>{findings.map((line) => <span key={line}>{line}</span>)}</Stack></Notice>
  return (
    <ConfirmModal
      title={force ? 'FORCE REMOVE WORKTREE' : 'REMOVE WORKTREE'}
      message={worktreeRemoveConfirm(worktree, force)}
      details={<Stack gap={0} insetTop={3} data-testid="worktree-check">{details}</Stack>}
      confirmLabel={ready === null ? 'Checking…' : force ? 'Force remove' : 'Remove'}
      confirmDisabled={ready === null}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
