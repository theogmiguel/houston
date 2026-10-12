import type { HTMLAttributes, ReactNode } from 'react'
import { variants } from './variants'
import { Text } from './Text'

const cardClasses = variants('border', {
  tone: {
    default: 'border-[var(--divider)] bg-[var(--card-bg)]',
    inset: 'border-[var(--divider)] bg-[var(--content-bg)]',
    'material-inset': 'border-[var(--material-inset-brd)] bg-[var(--material-inset-bg)]',
    danger: 'border-[var(--danger)] bg-[var(--status-blocked-bg)]',
    surface: 'border-[var(--border)] bg-[var(--surface)]',
    block: 'border-[var(--border)] bg-[var(--card-bg)]',
    plate: 'border-0 bg-[var(--field-plate-bg)]'
  },
  shape: { button: 'rounded-[var(--tr-radius-button)]', md: 'rounded-[var(--tr-radius-md)]', card: 'rounded-[var(--tr-radius-card)]', inset: 'rounded-[var(--tr-radius-sm)]' },
  padding: { none: '', page: 'p-[var(--space-4)]', md: 'p-[var(--space-3)]', sm: 'p-[var(--space-2-5)]', invocation: 'px-[var(--space-card-invocation-x)] py-[var(--space-card-invocation-y)]', note: 'px-[var(--space-card-note-x)] py-[var(--space-card-note-y)]', roomy: 'p-[var(--space-7)]' },
  borderStyle: { solid: '', dashed: 'border-dashed' },
  disabled: { false: '', true: 'opacity-50' },
  clip: { false: 'overflow-visible', true: 'overflow-hidden' }
}, { tone: 'default', shape: 'button', padding: 'none', borderStyle: 'solid', disabled: 'false', clip: 'true' })

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  tone?: 'default' | 'inset' | 'material-inset' | 'danger' | 'surface' | 'block' | 'plate'
  disabled?: boolean
  borderStyle?: 'solid' | 'dashed'
  clip?: boolean
  shape?: 'button' | 'md' | 'card' | 'inset'
  padding?: 'none' | 'page' | 'md' | 'sm' | 'invocation' | 'note' | 'roomy'
  className?: string
  layout?: 'default' | 'center-stack' | 'sleeping-session' | 'scrolling-copy'
}

export interface CardContentProps {
  children: ReactNode
}

export interface CardGroupProps {
  children: ReactNode
  rail?: 'new' | 'still' | 'gone'
}

export interface CardRowProps {
  heading: ReactNode
  meta?: ReactNode
  status?: ReactNode
  action?: ReactNode
  rail?: 'new' | 'still' | 'gone'
  compact?: boolean
  className?: string
  density?: 'default' | 'compact'
  layout?: 'default' | 'meta-actions' | 'source'
  separated?: boolean
}

const railClasses = variants('relative before:absolute before:inset-y-[var(--space-1)] before:left-0 before:w-[var(--w-card-rail)]', {
  rail: {
    new: 'before:bg-[var(--warn)]',
    still: 'before:bg-[var(--stop)]',
    gone: 'before:bg-[var(--ok)]'
  }
}, { rail: 'new' })

function CardRow({ heading, meta, status, action, rail, compact = false, className = '', density = 'default', layout = 'default', separated = true }: CardRowProps): React.JSX.Element {
  if (layout === 'meta-actions') return <div data-card-row-layout="meta-actions" className={`grid min-w-0 gap-[var(--space-0-5)] px-[var(--space-2-5)] py-[var(--space-1-5)] hover:bg-[var(--hover-fill)] ${className}`}>
    <Text as="div" size="ui" tone="primary" className="truncate">{heading}</Text>
    <div className="flex min-w-0 items-center gap-[var(--space-2)]">
      <Text as="div" size="small" tone="muted" className="min-w-0 flex-1 truncate">{meta}</Text>
      <div className="flex flex-none items-center gap-[var(--space-2)]">{status}{action}</div>
    </div>
  </div>
  if (layout === 'source') return <div className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-[var(--space-3)] rounded-[var(--tr-radius-sm)] px-[var(--space-3)] py-[var(--space-2)] hover:bg-[var(--hover-fill)] ${className}`}>
    <div className="grid min-w-0 gap-[var(--space-0-5)]"><Text as="div" size="ui" tone="primary">{heading}</Text><Text as="div" size="small" leading="small" tone="muted">{meta}</Text></div>
    {status}{action}
  </div>
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-[var(--space-2)] ${density === 'compact' ? 'px-[var(--space-2-5)]' : 'px-[var(--space-3)]'} ${compact ? 'py-[var(--space-1)]' : 'py-[var(--space-2)]'} ${separated ? '[&+&]:border-t [&+&]:border-[var(--divider)]' : ''} hover:bg-[var(--hover-fill)] ${rail ? railClasses({ rail }) : ''} ${rail ? 'pl-[var(--space-4)]' : ''} ${className}`}>
      <div className={compact ? 'flex min-w-0 flex-1 flex-wrap items-baseline gap-x-[var(--space-2)]' : 'grid min-w-0 flex-1 gap-[var(--space-1)]'}>
        <Text as="div" size="ui" weight="semibold" tone="primary" className="truncate">{heading}</Text>
        {meta && <Text as="div" size="small" leading="small" tone="muted" className={compact ? 'whitespace-nowrap' : ''}>{meta}</Text>}
      </div>
      {(status || action) && <div className="ml-auto flex flex-none flex-wrap items-center justify-end gap-[var(--space-1-5)]">{status}{action}</div>}
    </div>
  )
}

function CardBase({ children, tone = 'default', shape = 'button', padding = 'none', disabled = false, borderStyle = 'solid', clip = true, className = '', layout = 'default', ...props }: CardProps): React.JSX.Element {
  const layoutClass = {
    default: '',
    'center-stack': 'flex flex-col items-center gap-[var(--space-4)]',
    'sleeping-session': 'mx-auto grid w-full max-w-[70ch] gap-[var(--space-2)] text-center',
    'scrolling-copy': 'max-h-[16rem] overflow-auto whitespace-pre-wrap text-left'
  }[layout]
  return <div {...props} className={`${cardClasses({ tone, shape, padding, borderStyle, disabled: disabled ? 'true' : 'false', clip: clip ? 'true' : 'false' })} ${layoutClass} ${className}`}>{children}</div>
}

function CardContent({ children }: CardContentProps): React.JSX.Element {
  return <div className="grid gap-[var(--space-1)] px-[var(--space-2-5)] pb-[var(--space-2)]">{children}</div>
}

function CardGroup({ children, rail }: CardGroupProps): React.JSX.Element {
  return <section className={`grid gap-[var(--space-1)] ${rail ? railClasses({ rail }) : ''}`}>{children}</section>
}

export const Card = Object.assign(CardBase, { Row: CardRow, Content: CardContent, Group: CardGroup })
