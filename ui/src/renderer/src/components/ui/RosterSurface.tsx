import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { Button } from './Button'
import { Text } from './Text'
import { BTN_ICO } from './buttonChrome'

// Children roster: the expanded column, the collapsed strip and their rows.
// The `children-*` hook classes stay on the markup so tests and the pane
// header can address the roster; they carry no style.

export function EndedStatusDot(): React.JSX.Element {
  return <span className="agent-dot w-[var(--sz-status-dot)] h-[var(--sz-status-dot)] rounded-full flex-none bg-[var(--info)]" role="img" aria-label="Ended" />
}

// Below this container width the split shows the strip instead of the column.
const SPLIT_AUTO_STRIP_HIDDEN = '[.children-split.auto>&]:hidden'
const SPLIT_NARROW_STRIP_SHOWN = '[@container_(max-width:var(--w-roster-split-narrow))]:[.children-split.auto>&]:flex'
const SPLIT_NARROW_COLUMN_HIDDEN = '[@container_(max-width:var(--w-roster-split-narrow))]:[.children-split.auto>&]:hidden'

export function RosterSplit({ collapsed, children }: { collapsed: boolean; children: ReactNode }): React.JSX.Element {
  return <div className={`children-split ${collapsed ? 'collapsed' : 'auto'} flex-1 min-h-0 flex`}>{children}</div>
}

export function RosterColumn({ className = '', ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <aside
      {...props}
      className={`children-column w-[var(--w-roster-column)] flex-none border-r border-r-[var(--divider)] bg-[var(--card-bg)] flex flex-col min-h-0 overflow-hidden ${SPLIT_NARROW_COLUMN_HIDDEN} [&_.tkchip]:px-[var(--space-roster-chip-inline)]! ${className}`}
    />
  )
}

export function RosterStrip({ className = '', ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <aside
      {...props}
      className={`children-strip w-[var(--w-roster-strip)] flex-none border-r border-r-[var(--divider)] bg-[var(--card-bg)] flex flex-col items-center gap-[var(--space-zero-half)] py-1.5 overflow-y-auto overflow-x-hidden ${SPLIT_AUTO_STRIP_HIDDEN} ${SPLIT_NARROW_STRIP_SHOWN} ${className}`}
    />
  )
}

export function RosterHead({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="children-head flex items-center gap-2 h-[var(--h-roster-header)] flex-none pl-3 pr-1 border-b border-b-[var(--divider)] [font-size:var(--tr-text-sm)] font-semibold">
      {children}
    </div>
  )
}

export function RosterCount({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="children-count [font-family:var(--font-mono)] [font-size:var(--tr-text-xs)] text-[var(--text-faint)]">{children}</span>
}

export function RosterList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="children-list overflow-y-auto overflow-x-hidden flex-1 min-h-0 pt-1.5">{children}</div>
}

export function RosterGroupHead({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="children-group [font-size:var(--tr-text-xs)] font-bold [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)] pt-3 px-3.5 pb-1 flex justify-between items-center gap-2">
      {children}
    </div>
  )
}

export function RosterGroupToggle({ children, ...props }: { children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>): React.JSX.Element {
  return (
    <button
      {...props}
      className="children-group-toggle ml-auto inline-flex items-center gap-1 p-0 border-0 bg-transparent [font:inherit] [letter-spacing:0] normal-case text-[var(--text-faint)] cursor-pointer hover:text-[var(--text-primary)] aria-pressed:text-[var(--text-primary)]"
    >
      {children}
    </button>
  )
}

export function RosterRow({ selected, settled, children }: { selected: boolean; settled: boolean; children: ReactNode }): React.JSX.Element {
  const hook = `children-row ${settled ? 'settled' : ''} ${selected ? 'selected' : ''}`
  const fill = selected ? 'bg-[var(--selected-fill)] hover:bg-[var(--selected-fill)]' : 'hover:bg-[var(--hover-fill)]'
  return (
    <div className={`${hook} relative flex flex-wrap items-center gap-[var(--space-zero-half)] mx-[var(--space-1-5)] px-2 py-1.5 rounded-[var(--tr-radius-sm)] ${fill} ${settled ? '[&_strong]:text-[var(--text-secondary)]' : ''}`}>
      {children}
    </div>
  )
}

export function RosterSlot({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="children-slot w-[var(--w-roster-slot)] relative flex-none [font-size:var(--tr-text-xs)] text-[var(--text-faint)] text-right [font-family:var(--font-mono)]">
      {children}
    </span>
  )
}

export function RosterState({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="children-state block overflow-hidden text-ellipsis whitespace-nowrap [.children-row:hover_&]:hidden [.children-row:focus-within_&]:hidden">
      {children}
    </span>
  )
}

export function RosterActions({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="children-actions hidden items-center justify-end absolute right-0 top-0 bg-[var(--card-bg)] [.children-row:hover_&]:flex [.children-row:focus-within_&]:flex [.children-row.selected_&]:bg-[var(--card-hover)]">
      {children}
    </span>
  )
}

export function RosterDetail({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="rosterDetail" tone="muted" className="children-detail flex items-center gap-[var(--space-1-5)] w-full min-w-0 pl-[var(--space-roster-indent)]">{children}</Text>
  )
}

export function RosterFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <footer className="children-footer flex items-center gap-1 p-2 border-t border-t-[var(--divider)] [font-size:var(--tr-text-xs)] [&>button]:flex-1 [&>button]:min-w-0 [&>button]:px-[var(--space-1)]">
      {children}
    </footer>
  )
}

export function RosterFooterButton(props: Omit<React.ComponentProps<typeof Button>, 'variant' | 'className'>): React.JSX.Element {
  return <Button {...props} variant="legacy-roster-footer" />
}

export function RosterRule(): React.JSX.Element {
  return <span className="children-rule w-5 h-px bg-[var(--divider)] my-1 flex-none" />
}

export function RosterStatus({ state, children }: { state: string | undefined; children: ReactNode }): React.JSX.Element {
  return (
    <span
      className="children-status inline-flex flex-none data-[state=done]:[&_.agent-dot]:bg-[var(--ok)] data-[state=failed]:[&_.agent-dot]:bg-[var(--stop)]"
      data-state={state}
    >
      {children}
    </span>
  )
}

export function RosterIconButton({
  pushEnd = false,
  ...props
}: { pushEnd?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>): React.JSX.Element {
  return <button {...props} className={`${BTN_ICO} ${CONTROL_SIZE_SQUARE_CLS.regular} ${pushEnd ? 'mt-auto' : ''}`} />
}

export function RosterGlyphButton(props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>): React.JSX.Element {
  return (
    <button
      {...props}
      className={`${BTN_ICO} ${CONTROL_SIZE_SQUARE_CLS.regular} children-glyph relative w-[var(--h-roster-glyph)]! h-[var(--h-roster-glyph)]! flex-none aria-pressed:bg-[var(--selected-fill)]! [&_.agent-dot]:absolute [&_.agent-dot]:right-[var(--space-dot-inset-x)] [&_.agent-dot]:bottom-[var(--space-dot-inset-y)] [&_.agent-dot]:shadow-[var(--shadow-roster-dot)]`}
    />
  )
}

export function RosterPeekbar({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="children-peekbar flex items-center gap-2 h-[var(--h-roster-peekbar)] min-h-[var(--h-roster-peekbar)] pl-2 pr-1.5 border-b border-b-[var(--divider)] bg-[var(--card-bg)] [font-size:var(--tr-text-sm)] overflow-hidden">
      {children}
    </div>
  )
}

export function RosterQueuePanel({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`queue-panel ${className}`} />
}

export function RosterOverview({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-[var(--space-2-5)] pb-[var(--space-3)] ${className}`} />
}

export function RosterSurfaceSpecimen(): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-2)]">
      <div className="flex h-[var(--h-roster-specimen)] overflow-hidden border border-[var(--divider)]">
        <RosterColumn aria-label="Children roster specimen">
          <RosterHead>
            <span className="flex-1">Children 2</span>
            <RosterIconButton aria-label="Collapse specimen">‹</RosterIconButton>
          </RosterHead>
          <RosterList>
            <RosterGroupHead>
              <span>Needs you</span>
              <RosterGroupToggle aria-pressed={false}>Show only</RosterGroupToggle>
              <span>1</span>
            </RosterGroupHead>
            <RosterRow selected={false} settled={false}>
              <Button variant="roster-open"><RosterStatus state={undefined}><EndedStatusDot /></RosterStatus><strong>backend</strong></Button>
              <RosterSlot>
                <RosterState>4m</RosterState>
                <RosterActions>
                  <RosterIconButton aria-label="Open specimen">o</RosterIconButton>
                </RosterActions>
              </RosterSlot>
              <RosterDetail><span className="truncate">backend child</span></RosterDetail>
            </RosterRow>
            <RosterRow selected settled>
              <Button variant="roster-open"><strong>docs</strong></Button>
              <RosterCount>pane 7</RosterCount>
            </RosterRow>
          </RosterList>
          <RosterFooter>
            <RosterFooterButton>Close settled (1)</RosterFooterButton>
          </RosterFooter>
        </RosterColumn>
        <RosterStrip aria-label="Children strip specimen">
          <RosterGlyphButton aria-label="Orchestrator specimen" aria-pressed>
            <EndedStatusDot />
          </RosterGlyphButton>
          <RosterRule />
          <RosterIconButton pushEnd aria-label="Show specimen">›</RosterIconButton>
        </RosterStrip>
      </div>
      <EndedStatusDot />
      <RosterQueuePanel>Ready tasks</RosterQueuePanel>
      <RosterOverview>Orchestrator overview</RosterOverview>
    </div>
  )
}
