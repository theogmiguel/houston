import type { HTMLAttributes, ReactNode } from 'react'

const GAP = {
  small: 'gap-[var(--space-2)]',
  medium: 'gap-[var(--space-2-5)]',
  large: 'gap-[var(--space-3)]',
} as const
const ALIGN = { center: 'items-center', baseline: 'items-baseline' } as const

export function Inline({
  gap = 'medium',
  wrap = false,
  align = 'center',
  insetTop = false,
  className = '',
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  gap?: keyof typeof GAP
  wrap?: boolean
  align?: 'center' | 'baseline'
  insetTop?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      {...props}
      className={`${insetTop ? 'pt-[var(--space-2)]' : ''} flex ${ALIGN[align]} ${GAP[gap]} ${wrap ? 'flex-wrap' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

export function InlineSpecimen(): React.JSX.Element {
  return (
    <Inline gap="small" wrap align="baseline">
      <span>Label</span>
      <span>Value</span>
    </Inline>
  )
}
