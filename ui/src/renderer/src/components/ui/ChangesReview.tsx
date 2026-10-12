import type { InputHTMLAttributes, ReactNode } from 'react'
import { IconSearch } from '../icons'
import { Icon } from './Icon'
import { KeyCap } from './KeyCap'

export function ChangesReviewWorkspace({ left, children }: { left: ReactNode; children: ReactNode }): React.JSX.Element {
  return <div data-testid="changes-review-workspace" className="flex min-h-0 flex-1">
    <div className="[&_.changes-file-label>span:last-child]:hidden [&_.changes-inline-chevron]:hidden flex w-[340px] flex-none flex-col min-h-0 border-r border-[var(--divider)]">{left}</div>
    <div className="flex min-w-0 flex-1 flex-col">{children}</div>
  </div>
}

export function ChangesFileFilter({ inputRef, ...props }: InputHTMLAttributes<HTMLInputElement> & { inputRef: React.Ref<HTMLInputElement> }): React.JSX.Element {
  return <div className="px-[var(--space-3)] pb-[var(--space-2)]">
    <div className="flex items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] px-[var(--space-2)] text-[var(--text-faint)]">
      <Icon glyph={IconSearch} role="small" />
      <input {...props} ref={inputRef} aria-label="Filter files" placeholder="Filter files" className="w-full min-w-0 h-[var(--h-ctl)] border-0 bg-transparent text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]" />
      <KeyCap>/</KeyCap>
    </div>
  </div>
}

export function ChangesReviewFooter({ index, count }: { index: number; count: number }): React.JSX.Element {
  return <div className="flex h-[var(--h-row)] flex-none items-center gap-[var(--space-3)] border-t border-[var(--divider)] px-[var(--space-4)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
    <span data-testid="changes-file-position">File {index} of {count}</span>
    <span><KeyCap>J</KeyCap> <KeyCap>K</KeyCap> next and previous file</span>
    <span className="ml-auto"><KeyCap>Esc</KeyCap> restore panel</span>
  </div>
}

export function ChangesReviewSpecimen(): React.JSX.Element {
  return <ChangesReviewWorkspace left={<ChangesFileFilter inputRef={null} />}><ChangesReviewFooter index={1} count={4} /></ChangesReviewWorkspace>
}
