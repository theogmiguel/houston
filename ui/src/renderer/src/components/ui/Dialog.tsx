import type { FormHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { MATERIAL_CLS, materialAttrs } from '../material'
import { MODAL_SCRIM_CLS } from '../overlayChrome'
import { Button } from './Button'
import { variants } from './variants'

const panelClasses = variants(
  'pop border border-[var(--border)]',
  {
    size: {
      compact: 'w-[380px] max-w-[92vw] rounded-[var(--tr-radius-md)]',
      medium: 'w-[420px] max-w-[92vw] rounded-[var(--tr-radius-md)]',
      wide: 'w-[480px] max-w-[92vw] rounded-[var(--tr-radius-md)]',
      hostKey: 'w-[460px] max-w-[92vw] rounded-[var(--tr-radius-md)]',
      update: 'flex max-h-[92vh] w-[460px] max-w-[92vw] flex-col rounded-[var(--tr-radius-md)]',
      browser: 'w-[428px] max-w-[calc(100vw_-_32px)] flex flex-col gap-3',
      handoff: 'w-[720px] max-w-[92vw] rounded-[var(--tr-radius-md)]',
      ssh: 'w-[min(440px,calc(100vw_-_32px))] p-6 flex flex-col gap-4 max-h-[calc(100vh_-_32px)] overflow-y-auto',
      paneHandoff: 'w-[min(1180px,94vw)] h-[min(940px,92vh)] max-w-[94vw] rounded-[var(--tr-radius-md)] overflow-hidden flex flex-col',
      git: 'w-[560px] max-w-[calc(100vw_-_2rem)] max-h-[calc(100vh_-_4rem)] rounded-[var(--tr-radius-card)] overflow-hidden flex flex-col'
    },
    surface: {
      raised: 'bg-[var(--raised)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))]',
      card: 'bg-[var(--card-bg)] shadow-[var(--shadow-2)]',
      git: 'bg-[var(--card-bg)] shadow-[var(--shadow-lg)]',
      browser: 'bg-[var(--card-bg)] shadow-[var(--shadow-lg)]',
      glass: MATERIAL_CLS['overlay-glass']
    }
  },
  { size: 'compact', surface: 'raised' }
)
const panelEnter = 'motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)]'
const panelExit = '[.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]'
const panelMotion = `${panelEnter} ${panelExit}`

export interface DialogPanelProps extends HTMLAttributes<HTMLDivElement> {
  size?: 'compact' | 'medium' | 'wide' | 'hostKey' | 'update' | 'browser' | 'handoff' | 'ssh' | 'paneHandoff' | 'git'
  surface?: 'raised' | 'card' | 'git' | 'browser' | 'glass'
  animated?: boolean
  className?: string
  ref?: Ref<HTMLDivElement>
}

export function DialogBackdrop({ children, onMouseDown, className = '', tone = 'modal' }: { children: ReactNode; onMouseDown?: HTMLAttributes<HTMLDivElement>['onMouseDown']; className?: string; tone?: 'modal' | 'git' | 'browser' }): React.JSX.Element {
  const backdropClass = tone === 'modal'
    ? MODAL_SCRIM_CLS
    : tone === 'git'
      ? 'fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[color-mix(in_srgb,var(--content-bg)_80%,transparent)] backdrop-blur-[4px]'
      : 'fixed inset-0 z-[var(--z-modal)] grid place-items-center'
  return <div className={`${backdropClass} ${className}`} onMouseDown={onMouseDown}>{children}</div>
}

export function DialogPanel({ size = 'compact', surface = 'raised', animated = true, className = '', ref, ...props }: DialogPanelProps): React.JSX.Element {
  const attrs = surface === 'glass' ? materialAttrs('overlay-glass') : {}
  return <div {...attrs} {...props} ref={ref} className={`${panelClasses({ size, surface })} ${animated ? panelMotion : ''} ${className}`} />
}

export type DialogFormProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'className' | 'ref'> & {
  className?: string
  ref?: Ref<HTMLFormElement>
}

export function DialogForm({ className = '', ref, ...props }: DialogFormProps): React.JSX.Element {
  return <form {...props} ref={ref} className={`${panelClasses({ size: 'ssh', surface: 'card' })} ${panelEnter} ${className}`} />
}

export function DialogTitle({ children, id, tone = 'subhead', layout = 'default', border = 'border' }: { children: ReactNode; id?: string; tone?: 'subhead' | 'ui'; layout?: 'default' | 'between' | 'baseline-between'; border?: 'border' | 'divider' }): React.JSX.Element {
  const classes = tone === 'subhead'
    ? `px-3.5 py-[11px] border-b ${border === 'border' ? 'border-border' : 'border-divider'} [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary ${layout === 'between' ? 'flex items-center justify-between gap-3' : layout === 'baseline-between' ? 'flex items-baseline justify-between gap-2' : ''}`
      : 'flex items-center gap-2 py-3.5 px-5 border-b border-[var(--divider)] flex-none [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]'
  return <div id={id} className={classes}>{children}</div>
}

export function DialogDescription({ children, id }: { children: ReactNode; id?: string }): React.JSX.Element {
  return <div id={id} className="text-text-secondary [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-relaxed">{children}</div>
}

export function DialogBody({ children, variant = 'default', className = '', ...props }: HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'scroll' | 'bounded' | 'plain'; className?: string }): React.JSX.Element {
  const baseClass = variant === 'default' ? 'p-5 space-y-4' : variant === 'bounded' ? 'p-5 space-y-4 max-h-[70vh] overflow-y-auto' : variant === 'scroll' ? 'flex-1 min-h-0 overflow-y-auto py-4 px-5 flex flex-col gap-3 [scrollbar-width:thin]' : ''
  return <div {...props} className={`${baseClass} ${className}`}>{children}</div>
}

export function DialogActions({ children, variant = 'default', className = '' }: { children: ReactNode; variant?: 'default' | 'footer' | 'stack' | 'row' | 'plain'; className?: string }): React.JSX.Element {
  const baseClass = variant === 'plain'
    ? ''
    : variant === 'default' || variant === 'stack'
    ? 'flex flex-col gap-2 px-5 pb-5'
    : variant === 'footer'
      ? 'flex-none flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--divider)]'
      : 'flex gap-2 justify-end items-center px-5 pb-5'
  const combined = `${baseClass} ${className}`
  return variant === 'default' ? <div className={combined}><div className="flex gap-2 justify-end">{children}</div></div> : <div className={combined}>{children}</div>
}

export function DialogSpecimen(): React.JSX.Element {
  return <DialogBackdrop onMouseDown={() => {}}><DialogForm role="dialog" aria-modal="true"><DialogTitle>Connect via SSH</DialogTitle><DialogBody><DialogDescription>Open a terminal on a remote machine.</DialogDescription></DialogBody><DialogActions variant="row"><Button variant="ghost">Cancel</Button><Button variant="primary">Connect</Button></DialogActions></DialogForm></DialogBackdrop>
}
