import type { ButtonHTMLAttributes, FormHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, Ref } from 'react'
import type { IconComponent } from '../icons'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { Icon } from './Icon'
import { POP_ORIGIN_CLS } from './overlayChrome'
import { BORDER_HAIRLINE_INSET } from './shadowChrome'
import { Text } from './Text'
import { Tooltip } from './Tooltip'
import { PaneHeadButton } from './PaneControls'
import './fileExplorer.css'

// Roles of a file explorer: tree, tab strip, breadcrumb,
// status strip, notices, context menu and the inline name form. Every visual
// class lives here; call sites pass layout classes only.

const join = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ')

const HAIRLINE_BORDER = 'border-[color-mix(in_srgb,var(--divider)_55%,transparent)]'
const STRIP_FILL = 'bg-[color-mix(in_srgb,var(--card-bg)_45%,transparent)]'

// 420px is where a 220px tree column plus a readable ~60-column editor line
// still both fit; below it the tree collapses to a toggleable overlay instead.
const TREE_VISIBLE = '[@container_(min-width:420px)]'

export function TabCloseButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <PaneHeadButton {...rest} size="tabClose" tone="danger" ladder={false} className={className} />
}

export function TabOverflowButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <PaneHeadButton {...rest} size="tabOverflow" tone="neutral" ladder={false} className={className} />
}

/** Text button on the legacy `btn` surface with its border removed. */
export function PlainButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...rest} className={join('btn border-none', className)} />
}

export function ExplorerColumns({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...rest} className={join('files-columns flex-1 min-h-0 flex', className)} />
}

export function TreeColumn({ open, className, ...rest }: HTMLAttributes<HTMLElement> & { open: boolean }): React.JSX.Element {
  return <aside {...rest} className={join('files-tree-column w-[220px] flex-none flex flex-col min-h-0 border-r', HAIRLINE_BORDER, open ? 'flex' : `hidden ${TREE_VISIBLE}:flex`, className)} />
}

export function TreeScroll({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...rest} className={join('flex-1 min-h-0 overflow-auto py-1 [scrollbar-width:thin]', className)} />
}

const ROW_BASE =
  'group/row w-full flex items-center gap-1.5 pr-2 min-h-[var(--h-ctl-mini)] text-left bg-transparent border-none ' +
  'text-[length:var(--tr-text-sm)] text-[var(--text-secondary)] whitespace-nowrap ' +
  'hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] hover:text-[var(--text-primary)] ' +
  'focus-visible:outline-none focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]'
const ROW_SELECTED = 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'

/** A row of the tree: indentation follows `depth`, wider in the split layout. */
export function TreeRow({ depth, split, selected, failed, className, style, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  depth: number
  split: boolean
  selected: boolean
  failed: boolean
  ref?: Ref<HTMLButtonElement>
}): React.JSX.Element {
  return <button {...rest} className={join(ROW_BASE, selected && ROW_SELECTED, failed && 'text-[var(--danger)]', className)} style={{ ...style, paddingLeft: split ? 8 + depth * 14 : 6 + depth * 12 }} />
}

export function TreeToggleSlot({ className, ...rest }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...rest} className={join('w-3 flex-none inline-flex items-center justify-center text-[var(--text-faint)]', className)} />
}

export function TreeRowLabel({ className, ...rest }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...rest} className={join('flex-1 min-w-0 overflow-hidden text-ellipsis', className)} />
}

export function TreeRowStatus({ tone, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone: 'danger' | 'added' | 'changed' | 'faint' }): React.JSX.Element {
  return <Text {...rest} as="span" size="xs" mono tone={tone === 'danger' ? 'stop' : tone === 'added' ? 'ok' : tone === 'changed' ? 'warn' : 'faint'} className={className} />
}

export function PaneNotice({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...rest} className={join('flex-1 min-h-0 flex flex-col items-center justify-center gap-1.5 p-4 text-center', className)} />
}

export function PaneNoticeTitle({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...rest} as="div" size="sm" weight="small" tone="primary" className={className} />
}

export function PaneNoticeHint({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...rest} as="div" size="xs" tone="muted" breakAll className={join('max-w-[36ch]', className)} />
}

export function NoticeAction({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...rest} className={join('btn', ROW_BASE, 'justify-center pl-2 rounded-[var(--tr-radius-sm)]', className)} />
}

export function TreeHead({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...rest} className={join('flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl)] min-h-[var(--h-ctl)] pl-[var(--space-2-5)] pr-[var(--space-1)] border-b border-[var(--divider)] text-[length:var(--tr-text-xs)] font-bold tracking-[0.1em] uppercase text-[var(--text-faint)]', className)} />
}

const SPLIT_BUTTON =
  `btn ${BTN_ICO_STRUCTURE} w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] rounded-[var(--tr-radius-sm)] text-[var(--text-muted)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]`

function SplitButton({ label, onClick, glyph }: { label: string; onClick: () => void; glyph: IconComponent }): React.JSX.Element {
  return <button type="button" className={SPLIT_BUTTON} aria-label={label} onClick={onClick}><Icon glyph={glyph} role="label" /></button>
}

/** Icon button of the split layout's tree head and tab strip. */
export function SplitIconButton(props: { label: string; onClick: () => void; glyph: IconComponent }): React.JSX.Element {
  return <Tooltip label={props.label}><SplitButton {...props} /></Tooltip>
}

export function TreeFilter({ className, children, ...rest }: HTMLAttributes<HTMLLabelElement> & { children: ReactNode }): React.JSX.Element {
  return <label {...rest} className={join('flex flex-none items-center gap-[var(--space-1-5)] h-[var(--h-pill)] mx-[var(--space-1-5)] [margin-top:var(--space-1-5)] [margin-bottom:var(--space-file-filter-tail)] px-[var(--space-2)] border border-[var(--border)] rounded-[var(--tr-radius-input)] text-[length:var(--tr-text-sm)] text-[var(--text-faint)] bg-[var(--content-bg)]', className)}>{children}</label>
}

export function TreeFilterInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...rest} className={join('flex-1 min-w-0 w-full border-0 p-0 bg-transparent text-[var(--text-secondary)] [font:inherit] placeholder:text-[var(--text-faint)]', className)} />
}

export function TreeSash({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...rest} className={join("flex-none w-px relative bg-[var(--border)] cursor-col-resize touch-none after:content-[''] after:absolute after:inset-y-0 after:-inset-x-[3px] after:z-[var(--z-sticky)] hover:w-[2px] hover:bg-[var(--accent)] data-[dragging=true]:w-[2px] data-[dragging=true]:bg-[var(--accent)]", className)} />
}

export function EditorColumn({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...rest} className={join('editor-leaf flex-1 min-w-0 min-h-0 flex flex-col bg-[var(--tool-code-bg)]', className)} />
}

export function ViewerHead({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...rest} className={join('flex items-center gap-[var(--space-2)] h-[var(--h-ctl)] min-h-[var(--h-ctl)] pl-[var(--space-2-5)] pr-[var(--space-1-5)] border-b border-[var(--divider)] bg-[var(--card-bg)] text-[length:var(--tr-text-sm)] text-[var(--text-secondary)]', className)} />
}

export function ViewerOpenButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={join(BTN_ICO_STRUCTURE, props.className)} />
}

const TAB_STRIP_HEIGHT = 'h-[30px] min-h-[30px]'

export function TabStrip({ split, className, ...rest }: HTMLAttributes<HTMLDivElement> & { split: boolean }): React.JSX.Element {
  const surface = split ? `${TAB_STRIP_HEIGHT} bg-[var(--card-bg)] border-[var(--divider)]` : `${HAIRLINE_BORDER} ${STRIP_FILL}`
  return <div {...rest} className={join('flex-none flex items-stretch border-b', surface, className)} />
}

export function TabScroll({ className, ...rest }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div {...rest} className={join('files-tab-scroll flex-1 min-w-0 flex items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} />
}

const TAB_BASE =
  'group/tab flex items-center gap-1.5 pl-2.5 flex-none max-w-[180px] border-r ' +
  'text-[length:var(--tr-text-sm)] text-[var(--text-muted)] cursor-default select-none ' +
  'hover:text-[var(--text-primary)]'
const TAB_ACTIVE = 'bg-[var(--tool-code-bg)] text-[var(--text-primary)]'

export function FileTab({ split, active, preview, className, ...rest }: HTMLAttributes<HTMLDivElement> & {
  split: boolean
  active: boolean
  preview: boolean
  ref?: Ref<HTMLDivElement>
}): React.JSX.Element {
  const metrics = split ? 'h-[30px] pr-2 border-[var(--divider)]' : `h-[var(--h-pill)] pr-1 ${HAIRLINE_BORDER}`
  return <div {...rest} className={join(TAB_BASE, metrics, active && TAB_ACTIVE, preview && 'italic', className)} />
}

export function TabLabel({ leftAligned, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { leftAligned?: boolean }): React.JSX.Element {
  return <span {...rest} className={join('flex-1 min-w-0 truncate', leftAligned && 'text-left', className)} />
}

export function TabGitMark({ added, small = false, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { added: boolean; small?: boolean }): React.JSX.Element {
  return <Text {...rest} as="span" data-added={added} size={small ? 'fileStatus' : 'xs'} tone={added ? 'ok' : 'warn'} mono className={className} />
}

export function Breadcrumb({ compact, className, ...rest }: HTMLAttributes<HTMLElement> & { compact?: boolean }): React.JSX.Element {
  return <Text {...rest} as="nav" size={compact ? 'fileBreadcrumb' : undefined} tone="faint" className={join('flex items-center gap-[var(--space-1-5)] h-[var(--h-pill)] min-h-[var(--h-pill)] pl-[var(--space-3)] pr-[var(--space-1-5)] border-b border-[var(--divider)] overflow-x-auto whitespace-nowrap', className)} />
}

export function BreadcrumbSegment({ className, ...rest }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...rest} className={join('inline-flex items-center gap-[var(--space-1-5)]', className)} />
}

export function BreadcrumbLink({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...rest} className={join('btn border-none text-inherit [font:inherit] p-0', className)} />
}

export function BreadcrumbCurrent({ className, ...rest }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return <Text {...rest} as="strong" weight="semibold" tone="secondary" className={className} />
}

export function TabError({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...rest} className={join('px-[var(--space-2-5)] py-[var(--space-1-5)] text-[length:var(--tr-text-sm)] text-[var(--stop)]', className)} />
}

export function StatusStrip({ split, className, ...rest }: HTMLAttributes<HTMLDivElement> & { split: boolean }): React.JSX.Element {
  const surface = split
    ? 'h-[24px] min-h-[24px] bg-[var(--card-bg)] border-[var(--divider)]'
    : `min-h-[var(--h-ctl-mini)] ${HAIRLINE_BORDER} ${STRIP_FILL}`
  return <div {...rest} className={join('flex-none flex items-center border-t', surface, className)} />
}

/** `end` pushes the cell and every cell after it to the strip's far edge. */
export function StatusCell({ mono, end, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { mono?: boolean; end?: boolean }): React.JSX.Element {
  return <Text {...rest} as="span" size="xs" tone="faint" mono={mono} className={join('px-2 whitespace-nowrap', end && 'ml-auto', className)} />
}

export function UnsavedDot(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...props} className="flex-none w-[7px] h-[7px] rounded-full bg-[var(--warning)]" />
}

const MENU_BASE =
  `ctx-menu fixed z-[var(--z-overlay)] flex flex-col p-1 bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] ${POP_ORIGIN_CLS}`
const MENU_SIZE = {
  tree: `min-w-[220px] max-h-[calc(100dvh-var(--space-4))] overflow-y-auto focus:outline-none focus-visible:shadow-[${BORDER_HAIRLINE_INSET}]`,
  tab: 'min-w-[180px]',
  overflow: 'min-w-[220px] max-w-[280px]'
} as const

export function ExplorerMenu({ size, className, ref, ...rest }: HTMLAttributes<HTMLDivElement> & { size: keyof typeof MENU_SIZE; ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div ref={ref} role="menu" tabIndex={-1} {...rest} className={join(MENU_BASE, MENU_SIZE[size], className)} />
}

const MENU_ITEM =
  'ctx-item border-none flex items-center justify-between gap-[14px] w-full py-[5px] px-2.5 rounded-[var(--tr-radius-input)] bg-transparent text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-left hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'

/** `rich` lays out a leading marker, a label and a trailing detail on one line. */
export function ExplorerMenuItem({ rich, className, ref, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { rich?: boolean; ref?: Ref<HTMLButtonElement> }): React.JSX.Element {
  return <button ref={ref} role="menuitem" {...rest} className={join('btn border-none', rich && 'flex items-center gap-2', MENU_ITEM, className)} />
}

export function ExplorerMenuCaption({ className, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text {...rest} as="div" size="caption" tone="faint" className={join(MENU_ITEM, 'pointer-events-none', className)} />
}

export function ExplorerMenuSeparator(): React.JSX.Element {
  return <div className="ctx-sep h-px bg-[var(--border)] my-1 mx-1.5 flex-none" />
}

export function NameForm({ className, ...rest }: FormHTMLAttributes<HTMLFormElement>): React.JSX.Element {
  return <form {...rest} className={join('flex-none flex items-center gap-2 p-2', className)} />
}

export function NameInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...rest} className={join('min-w-0 flex-1 bg-[var(--tool-code-bg)] border border-[var(--border)] rounded-[var(--tr-radius-sm)]', className)} />
}

export function FileExplorerSpecimen(): React.JSX.Element {
  return <ExplorerColumns style={{ height: 300, width: 520 }}>
      <TreeColumn open>
        <TreeScroll><TreeRow depth={0} split selected failed={false}><TreeToggleSlot>⌄</TreeToggleSlot><TreeRowLabel>src</TreeRowLabel></TreeRow><TreeRow depth={1} split selected={false} failed={false}><TreeToggleSlot /><TreeRowLabel>main.ts</TreeRowLabel><TreeRowStatus tone="changed">M</TreeRowStatus></TreeRow></TreeScroll>
      </TreeColumn>
      <EditorColumn>
        <TabStrip split><TabScroll><FileTab split active preview={false}>main.ts<TabCloseButton aria-label="Close main.ts">×</TabCloseButton></FileTab></TabScroll></TabStrip>
        <Breadcrumb compact><BreadcrumbSegment><BreadcrumbLink>src</BreadcrumbLink><BreadcrumbCurrent>main.ts</BreadcrumbCurrent></BreadcrumbSegment></Breadcrumb>
        <PaneNotice><PaneNoticeTitle>Preview</PaneNoticeTitle><PaneNoticeHint>File explorer roles</PaneNoticeHint></PaneNotice>
      </EditorColumn>
  </ExplorerColumns>
}
