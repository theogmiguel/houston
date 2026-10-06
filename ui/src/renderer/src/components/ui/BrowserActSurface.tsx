import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { Text } from './Text'
import { DialogBackdrop, DialogPanel, type DialogPanelProps } from './Dialog'

/* ------------------------------------------------------- act confirmation */

const ACT_NOTICE_BASE = 'flex gap-[var(--space-2)] items-start rounded-[var(--tr-radius-sm)] px-[var(--space-2-5)] py-[var(--space-2)] border'
const ACT_DENY_BUTTON_CLS =
  'btn h-[var(--h-ctl)] px-[var(--space-3)] rounded-[var(--tr-radius-button)] font-semibold border border-[var(--border-hover)] bg-[var(--card-bg)] text-[var(--text-primary)] hover:bg-[var(--card-hover)] disabled:opacity-[0.45] disabled:cursor-default'
const ACT_APPROVE_BUTTON_CLS =
  'btn h-[var(--h-ctl)] px-[var(--space-3)] rounded-[var(--tr-radius-button)] font-semibold border-0 text-[var(--content-bg)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-[0.45] disabled:cursor-default'
const ACT_OVERLAY_CLS =
  'absolute inset-0 z-[var(--z-sticky)] bg-[color-mix(in_srgb,var(--content-bg)_55%,transparent)] motion-safe:animate-[backdrop-in_var(--animate-t-scrim)_var(--animate-ease-scrim)]'
const ACT_CARD_CLS =
  'absolute w-[var(--browser-act-card-width)] max-w-[calc(100%_-_var(--space-6))] flex flex-col gap-[var(--space-2)] rounded-[var(--tr-radius-card)] border border-[var(--warning)] bg-[var(--card-bg)] p-[var(--space-3)] shadow-[var(--shadow-lg)] motion-safe:animate-[menu-in_var(--animate-t-fast)_var(--animate-ease-menu)]'
const ACT_MODAL_PANEL_CLS = 'rounded-[var(--tr-radius-card)] border-[var(--border-hover)] p-[var(--space-4)] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)]'

export function ConfirmationBadge({ children, ...props }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...props} className={`w-[var(--browser-confirm-badge-size)] h-[var(--browser-confirm-badge-size)] rounded-[var(--tr-radius-sm)] flex-none grid place-items-center text-[var(--content-bg)] bg-[var(--accent)] ${props.className ?? ''}`}><Text size="caption" weight="label">{children}</Text></span>
}

export function OriginStatus(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <Text {...props} as="span" size="caption" weight="label" className={`text-[var(--success)] ${props.className ?? ''}`} />
}

export function ConfirmationTitle(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <Text {...props} size="ui" weight="ui" className={`truncate ${props.className ?? ''}`} />
}

export function OriginBadge(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...props} as="div" size="small" weight="small" mono className={`inline-flex items-center gap-[var(--space-1-5)] self-start max-w-full px-[var(--space-2)] py-[var(--space-1)] rounded-[var(--tr-radius-sm)] border border-[var(--border-hover)] bg-[var(--content-bg)] truncate ${props.className ?? ''}`} />
}

export function ElementSummary(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...props} as="div" size="small" weight="small" className={`flex items-center gap-[var(--space-2)] min-w-0 ${props.className ?? ''}`} />
}

export function ElementReference(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <Text {...props} size="small" weight="small" mono className={`px-[var(--space-1-5)] py-[var(--space-0-5)] rounded-[var(--tr-radius-input)] bg-[var(--accent-muted)] text-[var(--accent-hover)] flex-none ${props.className ?? ''}`} />
}

export function PayloadDetails(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`flex flex-col gap-[var(--space-1)] ${props.className ?? ''}`} />
}

export function PayloadLabel(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...props} as="div" className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]" />
}

export function PayloadValue(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...props} as="div" size="small" weight="small" mono className={`break-words rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-2-5)] py-[var(--space-2)] max-h-24 overflow-auto whitespace-pre-wrap ${props.className ?? ''}`} />
}

export function WarningCallout(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...props} as="div" size="small" weight="small" className={`${ACT_NOTICE_BASE} border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[color-mix(in_srgb,var(--warning)_55%,var(--text-primary))] ${props.className ?? ''}`} />
}

export function TrustOption(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...props} as="div" size="small" weight="small" tone="muted" className={`flex items-center gap-[var(--space-2)] ${props.className ?? ''}`} />
}

export function ConfirmationCountdown(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <Text {...props} size="small" weight="small" tone="faint" mono className={`mr-auto ${props.className ?? ''}`} />
}

export const DecisionButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { decision: 'deny' | 'approve' }>(function DecisionButton({ decision, ...props }, ref) {
  return <button {...props} ref={ref} className={`${decision === 'approve' ? ACT_APPROVE_BUTTON_CLS : ACT_DENY_BUTTON_CLS} ${props.className ?? ''}`}><Text size="small" weight="semibold">{props.children}</Text></button>
})

export const ConfirmationOverlay = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ConfirmationOverlay(props, ref) {
  return <div {...props} ref={ref} className={`${ACT_OVERLAY_CLS} ${props.className ?? ''}`} />
})

export function ConfirmationScreenshot(props: React.ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element {
  return <img {...props} className={`absolute inset-0 w-full h-full object-cover object-left-top ${props.className ?? ''}`} />
}

export const ConfirmationCard = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ConfirmationCard(props, ref) {
  return <div {...props} ref={ref} className={`${ACT_CARD_CLS} ${props.className ?? ''}`} />
})

export function ConfirmationDialogBackdrop(props: { children: ReactNode; onMouseDown?: HTMLAttributes<HTMLDivElement>['onMouseDown']; className?: string }): React.JSX.Element {
  return <DialogBackdrop {...props} tone="browser" className={`bg-[var(--overlay)] motion-safe:animate-[backdrop-in_var(--animate-t-scrim)_var(--animate-ease-scrim)] ${props.className ?? ''}`} />
}

export function ConfirmationDialogPanel(props: DialogPanelProps): React.JSX.Element {
  return <DialogPanel {...props} className={`${ACT_MODAL_PANEL_CLS} ${props.className ?? ''}`} />
}

export function ConfirmationFootnote(props: HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <Text {...props} as="p" size="small" weight="small" tone="faint" flush />
}

export function BrowserActSpotlight({ rect, label }: { rect: { x: number; y: number; width: number; height: number }; label: string }): React.JSX.Element {
  const geometry: CSSProperties = { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
  return (
    <div
  className="absolute rounded-[var(--tr-radius-sm)] pointer-events-none outline outline-[length:var(--browser-focus-outline-width)] outline-offset-[var(--browser-focus-outline-offset)] outline-[color:var(--warning)] bg-[color-mix(in_srgb,var(--warning)_13%,transparent)] shadow-[var(--browser-spotlight-shadow)]"
      style={geometry}
    >
      <Text size="caption" weight="label" mono className="absolute -top-[var(--space-3)] -left-[var(--space-0-5)] px-[var(--space-1-5)] rounded-[var(--tr-radius-input)] bg-[var(--warning)] text-[var(--content-bg)]">{label}</Text>
    </div>
  )
}
