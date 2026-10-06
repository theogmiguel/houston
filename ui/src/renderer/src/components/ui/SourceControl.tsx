import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { MATERIAL_CLS, materialAttrs } from './material'
import { SEG_ITEM_CLS, SEG_ITEM_OFF_CLS, SEG_ITEM_ON_CLS, SEG_TRACK_CLS } from './segmentedChrome'

export function SourceControlSectionHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] tracking-[0.1em] uppercase text-[var(--text-muted)]">{children}</div>
}

export function SourceControlRow({ children, active = false }: { children: ReactNode; active?: boolean }): React.JSX.Element {
  return <div className={`group/row relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] text-[length:var(--tr-text-small-size)] ${active ? 'text-[var(--text-primary)] bg-[var(--selected-fill)]' : 'text-[var(--text-secondary)] hover:bg-[var(--hover-fill)]'}`}>{children}</div>
}

export function SourceControlCard({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} {...materialAttrs('inset')} className={`${MATERIAL_CLS.inset} rounded-[var(--tr-radius-sm)] overflow-hidden`}>{children}</div>
}

export function SourceControlMetaRow({ children, tone = 'default', wrap = false }: { children: ReactNode; tone?: 'default' | 'danger'; wrap?: boolean }): React.JSX.Element {
  const toneClass = tone === 'danger' ? 'bg-[color-mix(in_srgb,var(--danger)_7%,transparent)]' : ''
  return <div className={`flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] border-t border-t-[var(--divider)] first:border-t-0 text-[length:var(--tr-text-small-size)] ${wrap ? 'flex-wrap' : ''} ${toneClass}`}>{children}</div>
}

export function CompactTabList({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} role="tablist" className={`${SEG_TRACK_CLS} ${className}`}>{children}</div>
}

export function CompactTab({ selected, value, label, compactLabel, badge, onSelect, onKeyDown }: { selected: boolean; value: string; label: string; compactLabel?: string; badge?: ReactNode; onSelect: () => void; onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void }): React.JSX.Element {
  return <button type="button" role="tab" data-tab={value} data-testid={`scm-tab-${value}`} aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={onSelect} onKeyDown={onKeyDown} className={`${SEG_ITEM_CLS} gap-1.5 ${selected ? SEG_ITEM_ON_CLS : SEG_ITEM_OFF_CLS}`}>
      {compactLabel !== undefined ? <><span className="[@container_(max-width:420px)]:hidden">{label}</span><span className="hidden [@container_(max-width:420px)]:inline">{compactLabel}</span></> : label}{badge}
    </button>
}

export function GitPresenceDot({ tone, ...props }: HTMLAttributes<HTMLSpanElement> & { tone: 'ok' | 'warn' | 'stop' }): React.JSX.Element {
  const color = tone === 'ok' ? 'bg-[var(--ok)]' : tone === 'warn' ? 'bg-[var(--warn)]' : 'bg-[var(--stop)]'
  return <span {...props} className={`w-1.5 h-1.5 rounded-[var(--tr-radius-pill)] ${color}`} aria-hidden />
}

export function SourceControlHeaderBar({ children }: { children: ReactNode }): React.JSX.Element {
  return <header className="scbar flex-none flex items-center gap-2 h-[var(--h-pane-head)] pl-2.5 pr-1.5 overflow-hidden">{children}</header>
}

export function SourceControlResizeSurface(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className="absolute inset-y-0 -left-1 z-[var(--z-pane)] w-2 cursor-col-resize touch-none bg-transparent focus-visible:outline-none after:content-[''] after:absolute after:inset-0 after:mx-auto after:w-px after:rounded-[var(--tr-radius-pill)] after:bg-transparent motion-safe:after:[transition:background-color_0.1s_ease-out] focus-visible:after:bg-[var(--text-faint)] data-[dragging]:after:bg-[var(--text-faint)]" />
}

export function SourceControlPanelSurface({ children, hidden, ref, ...props }: HTMLAttributes<HTMLElement> & { hidden: boolean; ref?: Ref<HTMLElement> }): React.JSX.Element {
  return <aside {...props} ref={ref} className={`relative flex-none h-full min-h-0 flex flex-col overflow-visible @container ${MATERIAL_CLS.shell} ${hidden ? 'invisible' : ''}`} {...materialAttrs('shell')}>{children}</aside>
}

export function SourceControlContentStack({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-h-0 flex flex-col gap-1 overflow-hidden">{children}</div>
}

export function SourceControlViewStack({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-h-0 flex flex-col">{children}</div>
}

export function SourceControlTabSurface({ children, active, testId }: { children: ReactNode; active: boolean; testId: string }): React.JSX.Element {
  return <div className={`flex-1 min-h-0 flex-col ${active ? 'flex' : 'hidden'}`} data-testid={testId}>{children}</div>
}

export function SourceControlReviewFormSurface({ children, ...props }: HTMLAttributes<HTMLFormElement>): React.JSX.Element {
  return <form {...props} className="flex-none flex flex-col gap-2 p-2 border-t border-[var(--divider)]">{children}</form>
}

export function SourceControlReviewField(props: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea {...props} className="min-w-0 bg-[var(--tool-code-bg)] text-[var(--text-primary)]" />
}

export function SourceControlReviewSubmit({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className="btn border-none">{children}</button>
}
