import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

const GAP = {
  0: 'gap-0',
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-[var(--space-4)]',
  medium: 'gap-[var(--space-2-5)]',
  field: 'gap-[var(--space-form-fields)]',
  screen: 'gap-[var(--space-fullscreen-message)]'
} as const

const ALIGN = {
  stretch: '',
  start: 'items-start',
  end: 'items-end',
  center: 'items-center'
} as const

const INSET = {
  1: 'pt-[var(--space-1)]',
  2: 'pt-[var(--space-2)]',
  3: 'pt-[var(--space-3)]',
  4: 'pt-[var(--space-4)]',
  medium: 'pt-[var(--space-2-5)]'
} as const

const AXIS = {
  vertical: 'flex-col',
  horizontal: 'flex-row'
} as const

export type StackGap = keyof typeof GAP
export type StackAxis = keyof typeof AXIS
export type StackInset = keyof typeof INSET
export type InsetSpace = 'preview' | 'compact-top' | 'screen'

export type StackProps = Omit<HTMLAttributes<HTMLElement>, 'className'> & {
  as?: 'div' | 'header' | 'footer' | 'section'
  gap: StackGap
  axis?: StackAxis
  align?: keyof typeof ALIGN
  insetTop?: StackInset
  /** Layout classes only. */
  className?: string
  children?: ReactNode
}

/** A flex column (or row) with a fixed rhythm between its children. */
export function Stack({ as: Tag = 'div', gap, axis = 'vertical', align = 'stretch', insetTop, className = '', children, ...rest }: StackProps): React.JSX.Element {
  return <Tag {...rest} className={`flex ${AXIS[axis]} ${GAP[gap]} ${ALIGN[align]} ${insetTop ? INSET[insetTop] : ''} ${className}`}>{children}</Tag>
}

export function StackSpecimen(): React.JSX.Element {
  return (
    <Inset space="preview">
      <div data-testid="stack-specimen" className="flex gap-[var(--space-4)]">
        {(Object.keys(GAP) as StackGap[]).map((gap) => (
          <Stack key={String(gap)} gap={gap} align="center">
            <Text size="small">{String(gap)}</Text>
            <Text size="small">one</Text>
            <Text size="small">two</Text>
          </Stack>
        ))}
        <Stack gap={2} axis="horizontal" align="center">
          <Text size="small">row</Text>
          <Text size="small">one</Text>
          <Text size="small">two</Text>
        </Stack>
      </div>
    </Inset>
  )
}

/** Padding around a settings group body that has no row chrome of its own. */
export function Inset({ children, space, className = '' }: { children: ReactNode; space: InsetSpace; className?: string }): React.JSX.Element {
  const classes = space === 'preview'
    ? 'px-[var(--space-4)] pt-[var(--space-4)] pb-[var(--space-3)]'
    : space === 'compact-top' ? 'pt-[var(--space-2)]' : 'p-[var(--space-5)]'
  return <div className={`${classes} ${className}`}>{children}</div>
}
