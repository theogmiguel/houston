import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { RING_ACCENT_ICON } from './shadowChrome'

export function EditorActionGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="head-actions ml-auto flex flex-none items-center gap-[var(--space-editor-action-gap)]">{children}</span>
}

export function EditorHeaderButton({ children, tone, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; tone: 'accent' | 'danger' | 'regular' | 'info' }): React.JSX.Element {
  const toneClass = tone === 'accent'
    ? 'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[color-mix(in_srgb,var(--accent)_75%,var(--text-primary))]'
    : tone === 'danger'
      ? 'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)]'
      : tone === 'info'
        ? 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'
        : 'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] hover:text-[var(--text-primary)]'
  return <button {...props} className={`${BTN_ICO_STRUCTURE} h-[var(--h-ctl-mini)] w-[var(--h-ctl-mini)] p-0 rounded-[var(--tr-radius-sm)] [transition:background_0.16s_cubic-bezier(0.4,0,0.2,1),color_0.16s_ease,transform_0.18s_cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-px active:translate-y-0 active:scale-90 focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none [@container_(max-width:280px)]:w-5 [@container_(max-width:280px)]:h-5 [@container_(max-width:200px)]:w-[var(--h-icon-tight)] [@container_(max-width:200px)]:h-[var(--h-icon-tight)] [body:has(.pane.focus)_.pane:not(.focus)_&]:text-[color-mix(in_srgb,var(--text-muted)_92%,var(--text-primary))] ${toneClass} ${props.className ?? ''}`}>{children}</button>
}
