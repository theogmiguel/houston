import { memo } from 'react'
import { fileTypeIcon } from '../files/fileTypeIcons'
import { ThreadChangedFiles, ThreadReasoningRow } from '../ui/Thread'
import { revealInChanges } from '../../thread/changesReveal'
import type { ThreadItem } from '../../thread/threadModel'
import { displayTarget, formatDuration } from '../../thread/threadTurns'

type ReasoningItem = Extract<ThreadItem, { kind: 'reasoning' }>
type ChangesItem = Extract<ThreadItem, { kind: 'changes' }>

/** "Thinking · ~50 tokens" while live, "Thought for 12s · ~800 tokens" after. */
export function reasoningLabel(item: Pick<ReasoningItem, 'streaming' | 'redacted' | 'durationMs' | 'tokens'>): string {
  const parts = [item.streaming ? 'Thinking' : item.durationMs === null ? 'Thought' : `Thought for ${formatDuration(item.durationMs)}`]
  if (item.tokens !== null) parts.push(`~${item.tokens.toLocaleString()} tokens`)
  if (item.redacted) parts.push('redacted by Claude')
  return parts.join(' · ')
}

export const ThreadReasoningItem = memo(function ThreadReasoningItem({ item }: { item: ReasoningItem }): React.JSX.Element {
  return <ThreadReasoningRow label={reasoningLabel(item)} live={item.streaming} />
})

export const ThreadChangesCard = memo(function ThreadChangesCard({ item, cwd }: { item: ChangesItem; cwd?: string }): React.JSX.Element {
  const files = item.files.map((file) => {
    const path = displayTarget(file.path, cwd)
    return { path, glyph: fileTypeIcon(path), added: file.added, removed: file.removed }
  })
  return <ThreadChangedFiles files={files} onOpen={cwd ? (path) => revealInChanges({ path, cwd }) : undefined} />
})
