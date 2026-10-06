import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'
import type { IconComponent } from '../icons'
import { Button } from './Button'
import { Icon } from './Icon'
import { Text } from './Text'
import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS, popOriginStyle } from './overlayChrome'

// The hover card that describes a delegated pane, and the badge glyphs that open it.

export type DelegationTone = 'warn' | 'blocked' | 'info' | 'muted' | 'primary'

const TONE_VAR: Record<DelegationTone, string> = {
  warn: '--warn',
  blocked: '--status-blocked-text',
  info: '--info',
  muted: '--text-muted',
  primary: '--text-primary'
}

export function PopoverPanel({
  top,
  left,
  visible,
  ref,
  ...props
}: {
  top: number
  left: number
  visible: boolean
  ref?: Ref<HTMLDivElement>
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>): React.JSX.Element {
  const style: CSSProperties = {
    top,
    left,
    visibility: visible ? 'visible' : 'hidden',
    ...popOriginStyle('left', 'top')
  }
  return (
    <div
      {...props}
      ref={ref}
      role="dialog"
      {...OVERLAY_RAISED_ATTRS}
      className={`${OVERLAY_RAISED_CLS} fixed z-[var(--z-overlay)] w-[var(--w-popover-content)] overflow-hidden`}
      style={style}
    />
  )
}

export function PopoverHeader({ children, trailing }: { children: ReactNode; trailing?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
      {children}
      <span className="ml-auto" />
      {trailing}
    </div>
  )
}

export function PopoverTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="ui" weight="semibold" tone="primary" className="flex-none min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">{children}</Text>
}

export function PopoverDescription({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="xs" tone="muted" className="min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">{children}</Text>
}

export function StatusGlyph({ glyph, role, tone = 'muted' }: { glyph: IconComponent; role: 'small' | 'label'; tone?: DelegationTone }): React.JSX.Element {
  return <span style={{ color: `var(${TONE_VAR[tone]})` }}><Icon glyph={glyph} role={role} /></span>
}

export function IdentityLine({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="xs" tone="muted" className="px-3 pb-2.5">{children}</Text>
}

export function InlineSeparator(): React.JSX.Element {
  return <Text className="mx-[var(--space-inline-separator)]" tone="faint">·</Text>
}

export function Emphasis({ tone = 'default', children }: { tone?: 'default' | 'warn'; children: ReactNode }): React.JSX.Element {
  return <Text as="b" tone={tone === 'warn' ? 'warn' : 'secondary'} className="font-bold">{children}</Text>
}

export function DelegationSection({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="border-t border-t-[var(--divider)] px-3 py-2.5 flex flex-col gap-2">{children}</div>
}

export function Eyebrow({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="p" size="label" weight="label" tone="faint" flush>
      {children}
    </Text>
  )
}

export function DefinitionList({ children }: { children: ReactNode }): React.JSX.Element {
  return <dl className="m-0 grid grid-cols-[var(--w-definition-label)_minmax(0,1fr)] gap-x-2 gap-y-[var(--space-inline-separator)] items-baseline">{children}</dl>
}

export function DefinitionEntry({
  label,
  tone,
  bold = false,
  children
}: {
  label: string
  tone?: DelegationTone
  bold?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <>
      <Text as="dt" size="xs" tone="muted">{label}</Text>
      <Text as="dd" size="xs" tone={tone ?? 'secondary'} weight={bold ? 'semibold' : undefined} flush className="[overflow-wrap:anywhere]">
        {children}
      </Text>
    </>
  )
}

export function MutedText({ plain = false, children }: { plain?: boolean; children: ReactNode }): React.JSX.Element {
  return <Text tone="faint" className={plain ? "font-normal" : ""}>{children}</Text>
}

export function TabularNumber({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text tabular>{children}</Text>
}

export function PopoverActionButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      className="self-start justify-self-start px-1.5 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]"
      onClick={onClick}
    >
      Deliver now
    </Button>
  )
}

export function CrewList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col -mx-3 -mb-2.5">{children}</div>
}

export function CrewButton({
  identity,
  secondary,
  tone,
  state,
  onClick
}: {
  identity: string
  secondary: string
  tone: DelegationTone
  state: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="text"
      className="flex items-center gap-2 min-h-[var(--h-pill)] px-3 w-full text-left border-0 bg-transparent font-[inherit] cursor-pointer transition-[background] hover:bg-[var(--hover-fill)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:-2px]"
      onClick={onClick}
    >
      <Text
        as="span"
        data-testid="roster-identity"
        size="xs"
        weight="semibold"
        tone="primary"
        className="flex-none whitespace-nowrap overflow-hidden text-ellipsis max-w-[16ch]"
      >
        {identity}
      </Text>
      <Text as="span" data-testid="roster-secondary" size="xs" tone="faint" className="min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">
        {secondary}
      </Text>
      <Text className="ml-auto flex-none uppercase" size="caption" weight="label" tone={tone}>
        {state}
      </Text>
    </Button>
  )
}

export function BadgeCount({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="inline-flex items-baseline">{children}</span>
}

export function WaitingCount({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text tone="warn">{children}</Text>
}

export function BadgeSeparator({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text className="px-px" tone="muted">{children}</Text>
}

export function PopoverPanelSpecimen(): React.JSX.Element {
  return (
    <div className="w-[var(--w-popover-content)] overflow-hidden rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--pop-bg)]">
      <PopoverHeader trailing={<PopoverDescription>1 waiting</PopoverDescription>}>
        <PopoverTitle>Review</PopoverTitle>
        <PopoverDescription>Review API changes</PopoverDescription>
      </PopoverHeader>
      <IdentityLine>
        claude
        <InlineSeparator />
        child of <Emphasis>Orchestrator</Emphasis> <Emphasis tone="warn">at the cap</Emphasis>
      </IdentityLine>
      <DelegationSection>
        <Eyebrow>Children · waiting first</Eyebrow>
        <DefinitionList>
          <DefinitionEntry label="state" tone="warn" bold>needs input</DefinitionEntry>
          <DefinitionEntry label="ended">
            7:08:20 PM <MutedText plain>· 5m ago</MutedText> <TabularNumber>#31</TabularNumber>
          </DefinitionEntry>
        </DefinitionList>
        <PopoverActionButton onClick={() => {}} />
        <CrewList>
          <CrewButton identity="Review" secondary="reviewer" tone="info" state="working" onClick={() => {}} />
        </CrewList>
      </DelegationSection>
    </div>
  )
}
