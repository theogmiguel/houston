import { Button } from './Button'
import { Icon } from './Icon'
import { IconEllipsis } from '../icons'
import { SplitButton } from './SplitButton'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { MATERIAL_CLS, materialAttrs } from './material'
import { OVERLAY_GLASS_OVERLAY_CLS } from './overlayChrome'
import { Text } from './Text'

export function GitChangesToolbarSurface({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-testid="changes-diff-toolbar" className="flex items-center gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-1-5)] border-b border-b-[var(--divider)] flex-none flex-wrap">{children}</div>
}

export function GitCommitPanel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="changes-commit flex-none flex flex-col gap-[var(--space-1)] m-[var(--space-3)] p-[var(--space-1)] rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)]">{children}</div>
}

export function GitCommitMessageField(props: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea {...props} className="flex-1 min-w-0 min-h-[var(--h-ctl)] resize-none rounded-[var(--tr-radius-sm)] border border-transparent bg-transparent px-[var(--space-2)] py-[var(--space-1-5)] text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:border-[var(--border-focus)] focus-visible:outline-none" />
}

export function GitCommitMessageRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-1.5">{children}</div>
}

export function GitCommitActionRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-testid="changes-actions" className="flex items-center gap-[var(--space-2)] px-[var(--space-1)] pb-[var(--space-1)]">{children}</div>
}

export function GitCommitButtonGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center justify-end gap-[var(--space-2)] ml-auto">{children}</div>
}

export function GitCommitStagedCount({ children }: { children: ReactNode; compact: boolean }): React.JSX.Element {
  return <span data-testid="changes-staged-count" className={`min-w-0 flex-1 truncate text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]`}>{children}</span>
}

export function GitPrSummaryLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="xs" tone="muted" className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{children}</Text>
}

export function GitChangesSurface({ children, compact, state, reviewing, ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode; compact: boolean; state: string; reviewing: boolean; ref?: React.Ref<HTMLElement> }): React.JSX.Element {
  return <section {...props} className={`changes-pane flex-1 min-w-0 min-h-0 relative flex flex-col overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] ${MATERIAL_CLS.shell}`} data-testid="changes-pane" data-compact={compact} data-state={state} data-reviewing={reviewing ? 'true' : undefined} {...materialAttrs('shell')}>{children}</section>
}

export function GitChangesBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-testid="changes-body" className="flex-1 min-h-0 flex flex-col [@container_(min-width:720px)]:flex-row [@container_(min-width:720px)]:overflow-hidden">{children}</div>
}

export function GitChangesFileColumn({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-testid="changes-left" className="flex flex-col min-h-0 flex-none max-h-[45%] [@container_(min-width:720px)]:max-h-none [@container_(min-width:720px)]:h-full [@container_(min-width:720px)]:w-[300px] [@container_(min-width:720px)]:border-r [@container_(min-width:720px)]:border-r-[var(--divider)] border-b border-b-[var(--divider)] [@container_(min-width:720px)]:border-b-0">{children}</div>
}

export function GitChangesFileListFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-h-0 flex flex-col">{children}</div>
}

export function GitChangesWideActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="hidden [@container_(min-width:720px)]:flex [@container_(min-width:720px)]:flex-col flex-none">{children}</div>
}

export function GitChangesNarrowActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-none flex flex-col [@container_(min-width:720px)]:hidden">{children}</div>
}

export function GitCompactToolsAnchor({ children, view = false }: { children: ReactNode; view?: boolean }): React.JSX.Element {
  return <div data-changes-view={view ? "true" : undefined} className={view ? "relative inline-flex" : "changes-compact-tools"}>{children}</div>
}

export function GitCompactToolsSurface({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`changes-compact-tools-body z-[var(--z-popover)] ${OVERLAY_GLASS_OVERLAY_CLS}`}>{children}</div>
}

export function GitPrNotice({ children, hidden, testId }: { children: ReactNode; hidden?: boolean; testId: string }): React.JSX.Element {
  return <div hidden={hidden} data-testid={testId} className="flex-none px-2.5 py-1.5 border-t border-t-[var(--divider)] text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{children}</div>
}

export function GitPrSummaryLine({ children, hidden, testId }: { children: ReactNode; hidden?: boolean; testId: string }): React.JSX.Element {
  return <div hidden={hidden} data-testid={testId} className="flex-none flex items-center gap-2 px-2.5 py-1.5 border-t border-t-[var(--divider)] text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{children}</div>
}

export function RepositoryPanelState({ title, children, icon, action, testId }: { title: string; children: ReactNode; icon?: ReactNode; action?: ReactNode; testId?: string }): React.JSX.Element {
  return <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 p-6 text-center" data-testid={testId}>{icon && <span className="text-[var(--danger)]">{icon}</span>}<Text size="ui" weight="ui" tone="primary">{title}</Text><Text as="p" size="small" tone="muted" flush className="max-w-[46ch]">{children}</Text>{action}</div>
}


export function GitCommitSpecimen(): React.JSX.Element {
  return <div className="changes-pane w-[470px]" data-compact="true">
    <GitCommitPanel>
      <GitCommitMessageRow><GitCommitMessageField readOnly rows={3} value="fix(panes): repaint in the same frame after a resize" aria-label="Commit message specimen" /></GitCommitMessageRow>
      <GitCommitActionRow>
        <GitCommitStagedCount compact>4 files to <Text mono>inspector-polish</Text></GitCommitStagedCount>
        <GitCommitButtonGroup><SplitButton label="Commit" testId="changes-commit" onClick={() => {}} items={[{ label: 'Amend', onClick: () => {} }]} /></GitCommitButtonGroup>
      </GitCommitActionRow>
    </GitCommitPanel>
  </div>
}

export function GitCompactToolsTrigger(props: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }): React.JSX.Element {
  return <Button {...props} variant="ghost" size="sm" className="changes-tools-trigger" />
}

export function GitToolsTriggerSpecimen(): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-1)]">
    <GitCompactToolsTrigger aria-label="Git tools specimen"><Icon glyph={IconEllipsis} role="small" /></GitCompactToolsTrigger>
    <GitCompactToolsTrigger>View</GitCompactToolsTrigger>
  </div>
}
