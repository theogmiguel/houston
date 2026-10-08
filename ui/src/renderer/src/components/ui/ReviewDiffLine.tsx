import { ReviewButton } from './ReviewButtonRoles'
import type { ReactNode } from 'react'
import { variants } from './variants'
import { Text } from './Text'
import { IconPlus } from '../icons'

export type ReviewDiffLineKind = 'ctx' | 'add' | 'del' | 'hunk' | 'meta'

const lineClasses = variants('flex items-start pr-1 whitespace-pre', {
  kind: {
    ctx: 'text-[var(--text-secondary)]',
    add: 'text-[color-mix(in_srgb,var(--success)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--success)_12%,transparent)]',
    del: 'text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]',
    hunk: 'text-[color-mix(in_srgb,var(--info)_90%,var(--text-primary))] bg-[color-mix(in_srgb,var(--info)_8%,transparent)] font-semibold',
    meta: 'text-[var(--text-muted)]'
  },
  drafted: {
    false: '',
    true: 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
  }
}, { kind: 'ctx', drafted: 'false' })

export interface ReviewDiffLineProps {
  variant?: 'pr'
  kind: ReviewDiffLineKind
  drafted?: boolean
  oldLine: number | null
  newLine: number | null
  text: string
  action?: ReactNode
}

export function ReviewDiffLine({ variant, kind, drafted = false, oldLine, newLine, text, action }: ReviewDiffLineProps): React.JSX.Element {
  return (
    <div className={`${lineClasses({ kind, drafted: drafted ? 'true' : 'false' })}${variant === 'pr' ? ' pr-code-diff-line' : ''}`} data-kind={kind}>
      <Text size="xs" mono className="flex-none w-4 text-right select-none opacity-60" aria-hidden>{oldLine ?? ''}</Text>
      <Text size="xs" mono className="flex-none w-4 text-right select-none opacity-60" aria-hidden>{newLine ?? ''}</Text>
      <Text size="xs" mono className="flex-1 min-w-0">{text || ' '}</Text>
      {action}
    </div>
  )
}

export function ReviewDiffLineSpecimen(): React.JSX.Element {
  return (
    <div className="flex flex-col font-mono text-[length:var(--tr-text-xs)] leading-[1.55]">
      <ReviewDiffLine kind="ctx" oldLine={1} newLine={1} text="const value = 1" />
      <ReviewDiffLine kind="add" oldLine={null} newLine={2} text="const added = true" action={<ReviewButton variant="diff-line-action" icon={IconPlus} aria-label="Comment on line 2" />} />
      <ReviewDiffLine kind="del" oldLine={2} newLine={null} text="const removed = false" />
      <ReviewDiffLine kind="hunk" oldLine={3} newLine={3} text="@@ -1,2 +1,2 @@" />
      <ReviewDiffLine kind="meta" oldLine={null} newLine={null} text="\\ No newline at end of file" />
    </div>
  )
}
