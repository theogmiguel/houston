import type { ReactNode } from 'react'
import { Text } from './Text'

export function PrHeaderFrame({ top, title, sentence }: { top: ReactNode; title: ReactNode; sentence: ReactNode }): React.JSX.Element {
  return <header data-testid="pr-scroll-header" className="grid flex-none gap-[var(--space-1-5)] px-[var(--space-4)] pb-[var(--space-3)] pt-[var(--space-3)]">
    <div data-testid="pr-header-top" className="relative flex min-w-0 items-center gap-[var(--space-2)]">{top}</div>
    <Text as="h2" size="subhead" weight="subhead" tone="primary" flush data-testid="pr-title">{title}</Text>
    <Text as="div" size="small" tone="muted" data-testid="pr-sub">{sentence}</Text>
  </header>
}

export function PrHeaderActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="relative ml-auto flex items-center gap-[var(--space-1)]">{children}</div>
}

export function PrHeaderNumber({ children }: { children: ReactNode }): React.JSX.Element {
  return <span data-testid="pr-number" className="font-mono text-[var(--text-secondary)]">{children}</span>
}

export function PrHeaderAvatar({ author }: { author: string | null | undefined }): React.JSX.Element {
  return <span aria-hidden className="inline-flex w-[var(--space-4)] h-[var(--space-4)] items-center justify-center rounded-full bg-[var(--info)] text-[length:var(--tr-text-label-size)] font-semibold text-white">{author?.slice(0, 1).toUpperCase() ?? '?'}</span>
}

export function PrHeaderSentence({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="inline-flex flex-wrap items-center gap-x-[var(--space-1-5)]">{children}</span>
}

export function PrHeaderSpecimen(): React.JSX.Element {
  return <PrHeaderFrame top={<><span>Open</span><PrHeaderNumber>#95</PrHeaderNumber></>} title="Terminals keep their content while the inspector opens" sentence={<PrHeaderSentence><PrHeaderAvatar author="theo" />theo wants to merge inspector-polish into main · 12m ago</PrHeaderSentence>} />
}

export function PrStatusWord({ children, tone = 'ok', ...props }: React.HTMLAttributes<HTMLSpanElement> & { children: ReactNode; tone?: 'ok' | 'stop' | 'warn' | 'info' | 'muted' }): React.JSX.Element {
  return <span {...props} className="inline-flex items-center gap-[var(--space-1-5)] whitespace-nowrap text-[length:var(--tr-text-small-size)]" style={{ color: `var(--${tone === 'muted' ? 'text-muted' : tone})` }}><span aria-hidden className="w-[var(--space-1-5)] h-[var(--space-1-5)] rounded-full bg-current" />{children}</span>
}

export function PrMergeFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return <section data-testid="pr-merge-box" className="mx-[var(--space-3)] flex-none overflow-hidden rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)]">{children}</section>
}

export function PrReadinessRow({ tone, heading, detail, actions }: { tone: 'ok' | 'stop' | 'warn' | 'muted'; heading: ReactNode; detail?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return <div className="flex items-start gap-[var(--space-2-5)] border-b border-[var(--divider)] px-[var(--space-3)] py-[var(--space-2)]">
    <span aria-hidden style={{ color: `var(--${tone === 'muted' ? 'text-muted' : tone})` }}>{tone === 'ok' ? '✓' : tone === 'stop' ? '×' : '·'}</span>
    <div className="grid min-w-0 flex-1 gap-[var(--space-0-5)]"><Text size="ui" tone="primary">{heading}</Text>{detail && <Text size="small" tone="muted">{detail}</Text>}</div>{actions}
  </div>
}

export function PrMergeFooter({ consequence, children }: { consequence: ReactNode; children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] bg-[color-mix(in_srgb,var(--text-primary)_2%,transparent)] px-[var(--space-3)] py-[var(--space-2)]"><Text size="small" tone="muted" className="min-w-0 flex-1">{consequence}</Text>{children}</div>
}

export function PrMergeSpecimen(): React.JSX.Element {
  return <PrMergeFrame><PrReadinessRow tone="ok" heading="4 of 4 checks passed" detail="core, renderer, safety, licence inventory" /><PrReadinessRow tone="ok" heading="No review required" /><PrReadinessRow tone="ok" heading="No conflicts with main" /><PrMergeFooter consequence="5 commits become one"><span>Squash and merge</span></PrMergeFooter></PrMergeFrame>
}

type PrView = 'summary' | 'timeline' | 'files'
export function PrViewTabs({ value, timelineCount, fileCount, onChange, onPreload }: { value: PrView; timelineCount: number; fileCount: number; onChange: (value: PrView) => void; onPreload: (target: EventTarget) => void }): React.JSX.Element {
  const options: { value: PrView; label: string; count?: number }[] = [{ value: 'summary', label: 'Summary' }, { value: 'timeline', label: 'Timeline', count: timelineCount }, { value: 'files', label: 'Files', count: fileCount }]
  return <div role="tablist" aria-label="Pull request view" className="mx-[var(--space-3)] pt-[var(--space-4)] flex flex-none items-end gap-[var(--space-1)] border-b border-[var(--divider)]" onMouseOver={(event) => onPreload(event.target)} onFocusCapture={(event) => onPreload(event.target)}>
    {options.map((option, index) => <button type="button" key={option.value} role="tab" aria-selected={value === option.value} tabIndex={value === option.value ? 0 : -1} data-testid={`pr-pane-${option.value}`} className={`relative flex h-[var(--h-row)] items-center gap-[var(--space-1-5)] rounded-t-[var(--tr-radius-sm)] border-0 bg-transparent px-[var(--space-2-5)] text-[length:var(--tr-text-small-size)] font-medium ${value === option.value ? 'text-[var(--text-primary)] after:absolute after:inset-x-[var(--space-2-5)] after:-bottom-px after:h-[var(--space-0-5)] after:rounded-full after:bg-[var(--text-primary)] after:content-[\"\"]' : 'text-[var(--text-secondary)] hover:bg-[var(--hover-fill)]'}`} onClick={() => onChange(option.value)} onKeyDown={(event) => {
      const next = event.key === 'ArrowRight' ? (index + 1) % options.length : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null
      if (next === null) return
      event.preventDefault()
      onChange(options[next].value)
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }}>{option.label}{option.count !== undefined && <span className="tabular-nums text-[var(--text-muted)]">{option.count}</span>}</button>)}
  </div>
}

export function PrDescriptionFrame({ clamped, children }: { clamped: boolean; children: ReactNode }): React.JSX.Element {
  return <div data-testid="pr-description" data-clamped={clamped} className={`relative ${clamped ? 'max-h-[calc(var(--space-6)*4)] overflow-hidden after:absolute after:inset-x-0 after:bottom-0 after:h-[var(--space-6)] after:pointer-events-none after:bg-gradient-to-t after:from-[var(--rail-bg)] after:to-transparent' : ''}`}>{children}</div>
}

export function PrPropertyRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] py-[var(--space-0-5)] text-[length:var(--tr-text-small-size)]">{children}</div>
}

export function PrPropertyLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="w-[84px] flex-none text-[var(--text-muted)]">{children}</span>
}

export function PrChangeStats({ additions, deletions, files, commits }: { additions: number; deletions: number; files: number; commits: number }): React.JSX.Element {
  return <PrPropertyRow><PrPropertyLabel>Changes</PrPropertyLabel><span className="text-[var(--text-secondary)]"><span data-testid="pr-additions" className="text-[var(--ok)]">+{additions}</span> <span data-testid="pr-deletions" className="text-[var(--stop)]">−{deletions}</span> in {files} files · {commits} commits</span></PrPropertyRow>
}

export function PrHeaderAuthor({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="font-medium text-[var(--text-primary)]">{children}</span>
}

export function PrHeaderRef({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="font-mono text-[var(--text-muted)]">{children}</span>
}
