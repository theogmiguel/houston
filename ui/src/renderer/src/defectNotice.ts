import type { NoticeInput } from './notices'
import type { ServerMsg } from './houston/generated/ServerMsg'

/** A defect notice names its workspace as the app does, not by its path. */
export function defectNoticeWorkspace(path: string, workspaces: readonly { path: string; name: string }[]): string {
  return workspaces.find((workspace) => workspace.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** One dismissible workspace-top notice per defect notice, at most once a day by
 *  the daemon's own cap; it names the count and the newest title. */
export function handleDefectNotice(
  msg: ServerMsg,
  push: (notice: NoticeInput) => void,
  workspaces: readonly { path: string; name: string }[],
  review: (workspace: string) => void
): void {
  if (msg.type !== 'defect_notice') return
  const workspace = defectNoticeWorkspace(msg.workspace, workspaces)
  const one = msg.count === 1
  push({
    code: `defect:${msg.workspace}`,
    kind: 'warning',
    title: one ? `Suspected defect: ${msg.title}` : `${msg.count} suspected defects`,
    body: one ? workspace : `${workspace} · ${msg.title}`,
    durationMs: null,
    action: { label: 'Review', onClick: () => review(msg.workspace) }
  })
}
