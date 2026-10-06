import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { HIT_TARGET_28 } from '../hitTarget'
import { IconClose, IconRefresh } from '../icons'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { FOCUS_HALO, GLOW_ACCENT, GLOW_DANGER, GLOW_WARNING, RING_ACCENT_ICON } from './shadowChrome'
import { Icon } from './Icon'
import { URL_INPUT_CLS, WEBVIEW_HOST_CLS } from './panelChrome'
import { Text } from './Text'
import { Select, type SelectProps } from './Select'

const JOIN = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

export function PaneHeadActions(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...props} className={`head-actions flex items-center gap-[var(--space-px)] flex-none ${props.className ?? ''}`} />
}

/* ------------------------------------------------------------------- buttons */

const NAV_BUTTON_CLS =
  `inline-flex items-center justify-center ${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] text-[var(--text-muted)] bg-transparent border-0 flex-none [transition:color_0.14s_ease,background_0.14s_ease,transform_0.14s_ease] enabled:hover:text-[var(--text-primary)] enabled:hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] enabled:active:scale-[0.92] disabled:opacity-[0.28] disabled:cursor-default`

const DEVICE_BUTTON_CLS =
  'inline-flex items-center justify-center h-[var(--browser-device-button-height)] w-[var(--browser-device-button-width)] p-0 rounded-[var(--tr-radius-sm)] text-[var(--text-muted)] bg-transparent border-0 flex-none [transition:color_0.14s_ease,background_0.14s_ease,transform_0.14s_ease] enabled:hover:text-[var(--text-primary)] enabled:hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] enabled:active:scale-[0.92] disabled:opacity-[0.28] disabled:cursor-default [&_svg]:size-3! aria-pressed:bg-[var(--card-bg)]! aria-pressed:text-[var(--text-primary)]!'

const DEVICE_GROUP_CLS =
  'flex gap-0 h-[var(--browser-device-group-height)] p-[var(--space-px)] border border-[var(--border)] rounded-[var(--tr-radius-button)] bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]'

export function BrowserDeviceGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className={DEVICE_GROUP_CLS} role="group" aria-label="Device preset">
      {children}
    </div>
  )
}

export function BrowserNavigationButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${NAV_BUTTON_CLS} ${props.className ?? ''}`} />
}

export function DevicePresetButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${DEVICE_BUTTON_CLS} ${props.className ?? ''}`} />
}

const HEAD_BTN_BASE =
  `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] [transition:background_0.16s_cubic-bezier(0.4,0,0.2,1),color_0.16s_ease,transform_0.18s_cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-[var(--space-px)] active:translate-y-0 active:scale-90 focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none [@container_(max-width:280px)]:w-5 [@container_(max-width:280px)]:h-5 [@container_(max-width:200px)]:w-[var(--browser-control-size)] [@container_(max-width:200px)]:h-[var(--browser-control-size)] [body:has(.pane.focus)_.pane:not(.focus)_&]:text-[color-mix(in_srgb,var(--text-muted)_92%,var(--text-primary))]`

const HEAD_BTN_TONE = {
  regular:
    'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] hover:text-[var(--text-primary)]',
  danger:
    'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)]',
  info:
    'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'
} as const

export type BrowserHeadButtonTone = keyof typeof HEAD_BTN_TONE

export function BrowserHeadButton({
  tone = 'regular',
  ...props
}: { tone?: BrowserHeadButtonTone } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`btn ${BTN_ICO_STRUCTURE} ${HEAD_BTN_BASE} ${HEAD_BTN_TONE[tone]}`} />
}

const TAB_COUNT_BUTTON_CLS =
  'btn inline-flex items-center gap-[var(--browser-tab-tight-gap)] h-[var(--h-ctl-mini)] py-0 px-[var(--browser-button-inline-inset)] rounded-[var(--tr-radius-sm)] bg-transparent border-0 text-[var(--text-muted)] font-mono ' +
  `[transition:color_0.14s_ease,background_0.14s_ease] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] data-[open]:text-[var(--text-primary)] data-[open]:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)]`

export function TabCount(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <Text {...props} size="caption" weight="label" mono tabular className={`min-w-[var(--browser-tab-count-min-width)] text-center [letter-spacing:var(--browser-tab-count-tracking)] ${props.className ?? ''}`} />
}

export function TabCountButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${TAB_COUNT_BUTTON_CLS} ${props.className ?? ''}`} />
}

export function BrowserReloadGlyph({ loading }: { loading: boolean }): React.JSX.Element {
  return (
    <span className={loading ? 'loop-anim inline-flex animate-[spin_1s_linear_infinite]' : 'inline-flex'}>
      <Icon glyph={IconRefresh} role="ui" />
    </span>
  )
}

/* ----------------------------------------------------------------- url field */

export function UrlField(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`relative flex-1 min-w-0 flex items-center ${props.className ?? ''}`} />
}

export function BrowserUrlSearchIcon({ focused, hidden, children }: { focused: boolean; hidden: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <span
      className={`absolute left-[var(--space-1-5)] top-1/2 -translate-y-1/2 inline-flex pointer-events-none [transition:color_0.16s_ease] ${focused ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}
      aria-hidden
      hidden={hidden}
    >
      {children}
    </span>
  )
}

export function BrowserSecurityBadge({ insecure, children }: { insecure: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <Text as="span" size="xs" className={`inline-flex items-center gap-[var(--space-1)] px-[var(--browser-button-inline-inset)] flex-none ${insecure ? 'text-[var(--warn)]' : 'text-[var(--info)]'}`}>
      {children}
    </Text>
  )
}

export const BrowserUrlInput = forwardRef<
  HTMLInputElement,
  { variant: 'fresh' | 'address' } & InputHTMLAttributes<HTMLInputElement>
>(function BrowserUrlInput({ variant, ...props }, ref) {
  return <input ref={ref} {...props} className={`${URL_INPUT_CLS} ${variant === 'fresh' ? '!pl-[var(--browser-address-icon-inset)]' : '!pl-[var(--browser-address-input-inset)]'}`} />
})

/* ---------------------------------------------------------------- load bar */

export function BrowserLoadBar({ loading, progress }: { loading: boolean; progress: number | null | undefined }): React.JSX.Element {
  return (
    <div className="relative h-[var(--space-0-5)] w-full overflow-hidden flex-none z-[var(--z-base)]" aria-hidden>
      {loading &&
        (progress != null ? (
          <div
            className="absolute inset-y-0 left-0 w-full origin-left opacity-80 bg-[var(--text-primary)] [transition:transform_0.12s_ease]"
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress))})` }}
          />
        ) : (
          <div className="loop-anim absolute inset-0 opacity-60 motion-safe:w-2/5 motion-safe:bg-[linear-gradient(to_right,transparent,var(--text-primary)_50%,transparent)] motion-safe:[animation:rbrowser-progress-slide_1.15s_cubic-bezier(0.4,0,0.3,1)_infinite] motion-reduce:w-full motion-reduce:bg-[var(--text-primary)]" />
        ))}
    </div>
  )
}

/* ------------------------------------------------------------- status bands */

type BandTone = 'warning' | 'danger'

const BAND_BASE = 'flex items-center gap-[var(--space-2)] py-[var(--space-1-5)] pr-[var(--space-3)] pl-[var(--space-4)] flex-none z-[var(--z-base)]'
const BAND_TONE: Record<BandTone, string> = {
  warning:
    'text-[color-mix(in_srgb,var(--warning)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] border-[color-mix(in_srgb,var(--warning)_28%,transparent)]',
  danger:
    'text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] border-[color-mix(in_srgb,var(--danger)_28%,transparent)]'
}
const BAND_DOT: Record<BandTone, string> = {
  warning: `flex-none w-[var(--space-1-5)] h-[var(--space-1-5)] rounded-[var(--tr-radius-pill)] bg-warning shadow-[${GLOW_WARNING}]`,
  danger: `flex-none w-[var(--space-1-5)] h-[var(--space-1-5)] rounded-[var(--tr-radius-pill)] bg-danger shadow-[${GLOW_DANGER}]`
}
const BAND_TEXT_BTN =
  'btn flex-none py-[var(--browser-status-action-pad-y)] px-[var(--browser-button-inline-inset)] border-0 rounded-[var(--tr-radius-input)] bg-transparent text-inherit font-semibold [transition:background_0.12s_ease] hover:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)]'
const BAND_ICON_BTN = `btn flex-none inline-flex items-center justify-center w-[var(--browser-control-size)] h-[var(--browser-control-size)] rounded-[var(--tr-radius-input)] border-0 bg-transparent text-inherit hover:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] ${HIT_TARGET_28}`

export function BrowserStatusBand({
  tone,
  edge,
  indicator = false,
  action,
  dismiss,
  children,
  'data-testid': testId
}: {
  tone: BandTone
  edge: 'top' | 'bottom'
  indicator?: boolean
  action?: { label: string; onClick: () => void }
  dismiss?: { label: string; onClick: () => void }
  children: ReactNode
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <Text as="div" size="small" weight="small" className={JOIN(BAND_BASE, BAND_TONE[tone], edge === 'top' ? 'border-t' : 'border-b')} role="alert" data-testid={testId}>
      {indicator && <span className={BAND_DOT[tone]} aria-hidden />}
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {action && (
        <button type="button" className={BAND_TEXT_BTN} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {dismiss && (
        <button type="button" className={BAND_ICON_BTN} aria-label={dismiss.label} onClick={dismiss.onClick}>
          <Icon glyph={IconClose} role="label" />
        </button>
      )}
    </Text>
  )
}

/* ---------------------------------------------------- device row and stage */

const DEVROW_CLS =
  'flex items-center justify-between h-[var(--browser-device-row-height)] min-h-[var(--browser-device-row-height)] pr-[var(--space-2)] pl-[var(--space-2-5)] border-b border-[var(--divider)] text-[var(--text-faint)] [font-size:var(--browser-device-row-text-size)]'

export function BrowserDeviceRow({ className, children }: { className?: string; children: ReactNode }): React.JSX.Element {
  return <div className={JOIN(DEVROW_CLS, className)}>{children}</div>
}

export { BrowserCaption } from './BrowserPaneStates'

export function AgentIndicator(): React.JSX.Element {
  return <span className="agent-dot h-[var(--browser-agent-indicator-size)] w-[var(--browser-agent-indicator-size)] flex-none rounded-full bg-[var(--border-hover)]" aria-hidden />
}

const STAGE_CLS =
  'flex-1 min-h-0 min-w-0 flex flex-col items-center justify-center bg-[color-mix(in_srgb,var(--content-bg)_70%,var(--rail-bg))] p-[var(--space-4)] gap-[var(--space-2)] overflow-hidden'

export const BrowserStage = forwardRef<HTMLDivElement, { children: ReactNode }>(function BrowserStage({ children }, ref) {
  return (
    <div ref={ref} className={STAGE_CLS}>
      {children}
    </div>
  )
})

export type BrowserDeviceKind = 'desktop' | 'phone' | 'tablet'

const DEVICE_FRAME_BASE =
  'min-w-0 min-h-0 border border-[var(--border-hover)] bg-white overflow-hidden shadow-[var(--shadow-1)] flex flex-col'
const DEVICE_FRAME_CLS: Record<BrowserDeviceKind, string> = {
  desktop: `${DEVICE_FRAME_BASE} w-full flex-1 rounded-[var(--tr-radius-button)]`,
  phone: DEVICE_FRAME_BASE,
  tablet: DEVICE_FRAME_BASE
}

export const BrowserDeviceFrame = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { device: BrowserDeviceKind }>(function BrowserDeviceFrame({ device, className = '', ...props }, ref) {
  return <div {...props} ref={ref} className={`${DEVICE_FRAME_CLS[device]} ${className}`} />
})

export const BrowserWebviewSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { rounded?: boolean; native?: boolean }>(function BrowserWebviewSurface({ rounded = false, native = false, className = '', ...props }, ref) {
  return <div {...props} ref={ref} className={`${WEBVIEW_HOST_CLS} ${rounded ? 'rounded-b-[calc(var(--tr-radius-md)-1px)] [@container_(max-width:280px)]:rounded-b-[calc(var(--tr-radius-sm)-1px)]' : ''} ${native ? 'bg-[var(--content-bg)]!' : ''} ${className}`} />
})

export function BrowserDetachedPlaceholder({ onReattach }: { onReattach: () => void }): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[var(--space-3)] bg-[var(--content-bg)] text-[var(--text-secondary)]">
      <Text size="small" weight="small">Detached into its own window</Text>
      <button
        type="button"
        onClick={onReattach}
        className="bg-[var(--accent)] text-[var(--text-primary)] border-0 rounded-[var(--tr-radius-sm)] py-[var(--browser-detached-action-pad-y)] px-[var(--browser-detached-action-pad-x)] cursor-pointer"
      >
        <Text size="small" weight="semibold">Reattach</Text>
      </button>
    </div>
  )
}

/* -------------------------------------------------------------- tabs popover */

const TABS_POPOVER_CLS =
  'absolute top-[calc(100%_+_var(--space-1-5))] right-0 z-[var(--z-sticky)] min-w-[var(--browser-tab-popover-min-width)] max-w-[var(--browser-tab-popover-max-width)] p-[var(--space-1)] flex flex-col gap-[var(--space-1)] rounded-[var(--tr-radius-button)] bg-surface border border-border shadow-[var(--shadow-1)] motion-safe:[animation:menu-in_var(--animate-t-fast)_var(--animate-ease-menu)]'
const TABS_LIST_CLS = 'flex flex-col gap-[var(--space-px)] max-h-[var(--browser-tab-popover-max-height)] overflow-y-auto [scrollbar-width:thin]'
const TAB_ROW_CLS =
  'group/pop relative flex items-center gap-[var(--space-0-5)] rounded-[var(--tr-radius-sm)] text-text-secondary [transition:background_0.12s_ease,color_0.12s_ease] hover:bg-background hover:text-text-primary data-[active]:bg-background data-[active]:text-text-primary'
const TAB_ITEM_CLS =
  'btn flex-1 min-w-0 flex items-center gap-[var(--space-2)] py-[var(--space-1-5)] pr-[var(--space-1-5)] pl-[var(--space-2)] border-0 rounded-[var(--tr-radius-sm)] bg-transparent text-inherit text-left'
const TAB_FAVICON_CLS =
  'relative flex-none inline-flex items-center justify-center w-[var(--browser-control-size)] h-[var(--browser-control-size)] rounded-[var(--tr-radius-input)] bg-surface-hover text-text-secondary font-mono [--dot-pulse-opacity:0.45] group-data-[loading]/pop:loop-anim group-data-[loading]/pop:motion-safe:[animation:dot-pulse_1.2s_steps(4,end)_infinite] group-data-[loading]/pop:motion-reduce:opacity-70'
const TAB_FAVICON_IMG_CLS = 'absolute inset-0 w-full h-full object-contain bg-[inherit]'
const TAB_CLOSE_CLS =
  `btn flex-none inline-flex items-center justify-center w-[var(--browser-control-size)] h-[var(--browser-control-size)] rounded-[var(--tr-radius-input)] text-[color-mix(in_srgb,currentColor_55%,transparent)] bg-transparent border-0 p-0 opacity-0 [transition:opacity_0.12s_ease,color_0.12s_ease,background_0.12s_ease] group-hover/pop:opacity-100 group-focus-within/pop:opacity-100 group-data-[active]/pop:opacity-100 hover:text-text-primary hover:bg-[color-mix(in_srgb,var(--text-primary)_12%,transparent)] ${HIT_TARGET_28}`
const NEW_TAB_CLS =
  'btn flex items-center gap-[var(--space-2)] w-full py-[var(--browser-button-block-inset)] px-[var(--space-2-5)] rounded-[var(--tr-radius-button)] bg-transparent border border-dashed border-border text-text-secondary [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] [transition:color_0.14s_ease,background_0.14s_ease,border-color_0.14s_ease] hover:text-text-primary hover:border-[var(--text-muted)] hover:bg-background [&>span]:flex-1 [&>span]:text-left'

export const BrowserTabsPopover = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function BrowserTabsPopover(props, ref) {
  return <div {...props} ref={ref} className={`${TABS_POPOVER_CLS} ${props.className ?? ''}`} />
})

export function BrowserTabsList(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`${TABS_LIST_CLS} ${props.className ?? ''}`} />
}

export function BrowserTabRow(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`${TAB_ROW_CLS} ${props.className ?? ''}`} />
}

export function BrowserTabButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${TAB_ITEM_CLS} ${props.className ?? ''}`} />
}

export function BrowserTabFavicon(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  const { children, className = '', ...rest } = props
  return <span {...rest} className={`${TAB_FAVICON_CLS} ${className}`}><Text size="caption" weight="label" mono>{children}</Text></span>
}

export function BrowserTabTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" weight="small" className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{children}</Text>
}

export function BrowserTabFaviconImage(props: React.ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element {
  return <img {...props} className={`${TAB_FAVICON_IMG_CLS} ${props.className ?? ''}`} />
}

export function BrowserTabCloseButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${TAB_CLOSE_CLS} ${props.className ?? ''}`} />
}

export function BrowserNewTabButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${NEW_TAB_CLS} ${props.className ?? ''}`} />
}

/* ------------------------------------------------------------- element picker */

const PICKER_HINT_CLS =
  'flex items-center gap-[var(--space-2)] pt-[var(--space-1-5)] pr-[var(--space-1-5)] pb-[var(--space-1-5)] pl-[var(--space-2-5)] min-h-[var(--browser-picker-hint-height)] ' +
  'text-[color-mix(in_srgb,var(--text-primary)_80%,var(--accent)_10%)] border-t border-border flex-none'
const PICKER_DOT_CLS =
  `loop-anim w-[var(--space-1-5)] h-[var(--space-1-5)] rounded-[var(--tr-radius-pill)] bg-[var(--accent)] shadow-[${GLOW_ACCENT}] ` +
  'flex-none [--dot-pulse-opacity:0.45] [--dot-pulse-scale:0.82] ' +
  'motion-safe:animate-[dot-pulse-scale_1.8s_steps(4,end)_infinite]'
const PICKER_SELROW_CLS = 'flex items-center gap-[var(--browser-picker-row-gap)] py-[var(--space-1-5)] px-[var(--space-2-5)] border-t border-border min-w-0 flex-none'
const PICKER_INPUTROW_CLS = 'flex items-center gap-[var(--space-1-5)] pt-[var(--space-2)] pr-[var(--space-2-5)] pb-[var(--space-2-5)] pl-[var(--space-2-5)] border-t border-border flex-none'
const PICKER_PROMPT_INPUT_CLS =
  `flex-1 min-w-0 h-[var(--h-ctl)] rounded-[var(--tr-radius-button)] border border-border bg-surface text-text-primary px-[var(--space-2-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] outline-none focus-visible:shadow-[${FOCUS_HALO}] ` +
  'placeholder:text-text-muted'
const PICKER_AGENT_SELECT_CLS =
  'h-[var(--h-ctl)] rounded-[var(--tr-radius-button)] border border-border bg-surface text-text-primary px-[var(--space-2)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] flex-none'

const PICKER_SUBMIT_GLOSS = 'inset_0_1px_color-mix(in_srgb,#fff_22%,transparent)'
const PICKER_SUBMIT_CLS =
  'h-[var(--h-ctl)] px-[var(--space-3)] border-0 rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-small-size)] font-semibold text-white flex-none cursor-pointer ' +
  'bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent)_100%,white_8%)_0%,var(--accent)_100%)] ' +
  `shadow-[${PICKER_SUBMIT_GLOSS}] disabled:opacity-50 disabled:cursor-default`

export function BrowserPickerHint({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`${PICKER_HINT_CLS} ${props.className ?? ''}`}><span className={PICKER_DOT_CLS} aria-hidden /><Text size="small" weight="small" className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">{children}</Text></div>
}

export function BrowserPickerSelectionRow({ tag, component, status, ...props }: HTMLAttributes<HTMLDivElement> & { tag: ReactNode; component: ReactNode; status: ReactNode }): React.JSX.Element {
  return <div {...props} className={`${PICKER_SELROW_CLS} ${props.className ?? ''}`}><Text as="span" size="small" weight="small" mono className="text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] rounded-[var(--tr-radius-input)] py-[var(--space-px)] px-[var(--browser-picker-tag-inset)] flex-none">{tag}</Text><Text size="small" weight="small" tone="primary" className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-1">{component}</Text><Text size="small" weight="small" tone="quiet" className="ml-auto pr-[var(--space-1)] italic whitespace-nowrap overflow-hidden text-ellipsis">{status}</Text></div>
}

export function BrowserPickerInputRow(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`${PICKER_INPUTROW_CLS} ${props.className ?? ''}`} />
}

export const BrowserPickerPromptInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function BrowserPickerPromptInput(props, ref) {
  return <input {...props} ref={ref} className={`${PICKER_PROMPT_INPUT_CLS} ${props.className ?? ''}`} />
})

export function BrowserPickerAgentSelect(props: SelectProps): React.JSX.Element {
  return <Select {...props} chrome={PICKER_AGENT_SELECT_CLS} />
}

export function BrowserPickerSubmitButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${PICKER_SUBMIT_CLS} ${props.className ?? ''}`}>{props.children}</button>
}

/* ------------------------------------------------------------ full screen */

const FS_BACKDROP_CLS =
  'fixed inset-0 z-[var(--z-tooltip)] flex ' +
  'py-[clamp(var(--browser-fullscreen-backdrop-pad-y-min),var(--browser-fullscreen-backdrop-pad-y-fluid),var(--browser-fullscreen-backdrop-pad-y-max))] px-[clamp(var(--browser-fullscreen-backdrop-pad-x-min),var(--browser-fullscreen-backdrop-pad-x-fluid),var(--browser-fullscreen-backdrop-pad-x-max))] ' +
  'bg-[color-mix(in_srgb,#000_58%,transparent)] [backdrop-filter:blur(var(--browser-fullscreen-backdrop-blur))] ' +
  'motion-safe:animate-[backdrop-in_0.14s_ease-out]'

const FS_FOCUS_RING_CLS =
  '[&_:focus-visible]:outline [&_:focus-visible]:outline-[length:var(--browser-focus-outline-width)] [&_:focus-visible]:outline-[var(--text-primary)] [&_:focus-visible]:outline-offset-[var(--browser-focus-outline-offset)] [&_:focus-visible]:rounded-[var(--tr-radius-sm)]'

const FS_MODAL_CLS =
  'relative flex-1 min-w-0 min-h-0 flex flex-col ' +
  'bg-background border border-border rounded-[var(--tr-radius-card)] pt-0 px-[var(--space-1)] pb-[var(--space-1)] overflow-hidden ' +
  'shadow-[var(--shadow-2)] outline-none focus-visible:shadow-[var(--shadow-2)] ' +
  'motion-safe:animate-[panel-in_0.17s_cubic-bezier(0.22,0.8,0.2,1)] ' +
  FS_FOCUS_RING_CLS

const FS_URL_INPUT_CLS =
  'flex-1 min-w-0 h-[var(--h-ctl)] rounded-[var(--tr-radius-button)] border border-border [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] ' +
  `bg-[var(--tool-code-bg)] text-[var(--text-secondary)] px-[var(--space-2-5)] outline-none focus-visible:shadow-[${FOCUS_HALO}] cursor-default`
const FS_EXIT_BUTTON_CLS =
  `inline-flex items-center justify-center ${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] flex-none border-0 ` +
  'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] ' +
  'hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)] ' +
  '[transition:background_0.14s_ease,color_0.14s_ease,transform_0.14s_ease] active:scale-[0.92]'
export function FullscreenBackdrop(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`${FS_BACKDROP_CLS} ${props.className ?? ''}`} />
}

export function FullscreenPanel(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`${FS_MODAL_CLS} ${props.className ?? ''}`} />
}

export function FullscreenToolbar(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`flex-shrink-0 -mx-[var(--space-1)] bg-background ${props.className ?? ''}`} />
}

export function FullscreenToolbarRow(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`h-[var(--browser-fullscreen-row-height)] min-h-[var(--browser-fullscreen-row-height)] flex items-center justify-center gap-[var(--space-1-5)] px-[var(--space-3)] ${props.className ?? ''}`} />
}

export function FullscreenUrlField(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...props} className={`flex-[0_1_var(--browser-fullscreen-url-max-width)] flex min-w-0 ${props.className ?? ''}`} />
}

export const FullscreenUrlInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function FullscreenUrlInput(props, ref) {
  return <input {...props} ref={ref} className={`${FS_URL_INPUT_CLS} ${props.className ?? ''}`} />
})

export function FullscreenExitButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${FS_EXIT_BUTTON_CLS} ${props.className ?? ''}`} />
}

export const FullscreenContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function FullscreenContent(props, ref) {
  return <div {...props} ref={ref} className={`flex-1 min-w-0 min-h-0 flex rounded-b-[var(--tr-radius-button)] overflow-hidden ${props.className ?? ''}`} />
})
