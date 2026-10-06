import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

export function DictationSurface({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`pointer-events-none absolute inset-x-2 bottom-2 z-[var(--z-sticky)] flex items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-[var(--border-hover)] bg-[var(--card-bg)] px-[var(--space-2)] py-[var(--space-1-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.4] text-[var(--text-primary)] shadow-sm ${props.className ?? ''}`}>
    {children}
  </div>
}

export function DictationText({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }): React.JSX.Element {
  return <Text {...props} size="small" weight="small" tone="primary" mono className={`min-w-0 flex-1 truncate ${props.className ?? ''}`}>{children}</Text>
}

export function DictationAction({ tone, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone: 'insert' | 'discard' }): React.JSX.Element {
  return <button {...props} className={`btn pointer-events-auto flex-none rounded border border-[var(--border-hover)] px-[var(--space-1-5)] py-[var(--space-dictation-action-y)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] ${tone === 'insert' ? 'hover:border-[var(--accent)]' : 'hover:border-[var(--danger)]'} ${props.className ?? ''}`} />
}

export function MicrophoneStatus({ listening, children, ...props }: HTMLAttributes<HTMLSpanElement> & { listening: boolean; children: ReactNode }): React.JSX.Element {
  return <span {...props} className={`inline-flex h-[var(--h-ctl-mini)] w-[var(--h-ctl-mini)] flex-none items-center justify-center rounded-full ${listening ? 'loop-anim text-[var(--danger)] [--dot-pulse-opacity:0.4] [animation:dot-pulse_1.1s_steps(4,end)_infinite] motion-reduce:[animation:none]' : 'text-[var(--text-muted)]'} ${props.className ?? ''}`}>
    {children}
  </span>
}
