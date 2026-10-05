import type { SessionInfo } from './houston/client'
import type { NoticeInput } from './notices'
import type { OrchestrationNotificationContext } from './orchestrationNotifications'

export function orchestrationNotice(
  session: SessionInfo,
  kind: 'finished' | 'needs-input',
  context: OrchestrationNotificationContext,
  onFocusPane: (id: number) => void
): NoticeInput {
  const needsInput = kind === 'needs-input'
  return {
    code: `orchestration-${session.id}`,
    kind: needsInput ? 'warning' : 'success',
    title: `${session.title} ${needsInput ? 'needs your input' : 'finished'}`,
    body: `${context.agent} · ${context.workspace} › ${context.grid}`,
    durationMs: needsInput ? null : 5_000,
    presentation: 'orchestration',
    action: { label: 'Open pane', onClick: () => onFocusPane(session.id) }
  }
}
