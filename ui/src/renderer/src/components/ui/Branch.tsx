import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, Ref } from 'react'
import { Text } from './Text'
import { Tooltip } from './Tooltip'
import { Select, type SelectOption } from './Select'

export function GitBranchRow({ current, children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { current: boolean }): React.JSX.Element {
  return <div {...props} className={`group/row flex items-center gap-2 h-7 px-2 rounded-[var(--tr-radius-sm)] text-[length:var(--tr-text-sm)] ${current ? 'bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--card-hover)]'} ${className}`}>{children}</div>
}

export function GitBranchBadge({ role, children, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { role: 'current' | 'default' | 'worktree' }): React.JSX.Element {
  const tone = role === 'current'
    ? 'bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[var(--success)]'
    : role === 'default'
      ? 'bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)] text-[var(--text-muted)]'
      : 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)]'
  return <span {...props} className={`flex-none px-1.5 rounded-[var(--tr-radius-pill)] font-mono text-[length:var(--tr-text-xs)] font-semibold leading-4 ${tone} ${className}`}>{children}</span>
}

export function GitBranchDeleteMenu({ onDelete, onForceDelete }: { onDelete: () => void; onForceDelete: () => void }): React.JSX.Element {
  return <div role="menu" data-testid="branch-delete-menu" className="absolute right-0 top-7 z-[var(--z-sticky)] min-w-[170px] flex flex-col rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] py-1 shadow-[var(--shadow-1)]">
    <button type="button" role="menuitem" data-testid="branch-delete-safe" className="text-left px-2.5 py-1 text-[length:var(--tr-text-sm)] bg-transparent border-0 text-[var(--text-secondary)] enabled:hover:bg-[var(--card-hover)]" onClick={onDelete}>Delete</button>
    <button type="button" role="menuitem" data-testid="branch-delete-force" className="text-left px-2.5 py-1 text-[length:var(--tr-text-sm)] bg-transparent border-0 text-[var(--danger)] enabled:hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]" onClick={onForceDelete}>Force delete</button>
  </div>
}

export function GitRefInput({ className = '', ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }): React.JSX.Element {
  return <input {...props} ref={ref} className={`w-full h-[var(--h-git-ref-input)] px-[var(--space-3)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[0.72] ${className}`} />
}

export function GitRefFieldLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="block pb-[var(--space-overview-child-head)] [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]">{children}</span>
}

export function GitBranchNameText({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="xs" mono className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{children}</Text>
}

export function GitBranchNote({ label }: { label: string }): React.JSX.Element {
  return <Tooltip label={label} className="inline-flex max-w-[40%]"><Text as="span" size="xs" tone="faint" className="flex-none overflow-hidden text-ellipsis whitespace-nowrap">{label}</Text></Tooltip>
}

export function GitBranchCreateRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-2">{children}</div>
}

export function GitBranchList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div role="list" data-testid="branches-list" className="flex flex-col">{children}</div>
}

export function GitBaseSelect({ value, options, onChange, disabled, label }: { value: string; options: readonly SelectOption[]; onChange: (value: string) => void; disabled?: boolean; label: string }): React.JSX.Element {
  return <div className="w-[150px] flex-none"><Select value={value} options={options} onChange={onChange} aria-label={label} data-testid="branch-new-base" disabled={disabled} /></div>
}

export function GitBranchCreateSurface({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-2 p-2.5 rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)]">{children}</div>
}

export function GitBranchSelect({ children, disabled, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} type="button" disabled={disabled} onClick={onClick} className="flex flex-1 min-w-0 items-center gap-2 bg-transparent border-0 p-0 text-left text-inherit disabled:opacity-55 disabled:cursor-not-allowed">{children}</button>
}

export function GitBranchEmptyText({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="p" size="small" tone="muted" flush className="px-2 py-3">{children}</Text>
}

export function GitBranchHelpText({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="p" size="small" tone="muted" flush>{children}</Text>
}
