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
