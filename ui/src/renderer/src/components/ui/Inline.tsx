import type { HTMLAttributes, ReactNode } from 'react'

const GAP = {
  small: 'gap-[var(--space-2)]',
  medium: 'gap-[var(--space-2-5)]',
  large: 'gap-[var(--space-3)]',
  spacious: 'gap-[var(--space-5)]',
} as const
const ALIGN = { center: 'items-center', baseline: 'items-baseline', start: 'items-start', end: 'items-end' } as const

export function Inline({
  as: Tag = 'div',
  gap = 'medium',
  wrap = false,
  align = 'center',
  insetTop = false,
  className = '',
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'span'
  gap?: keyof typeof GAP
  wrap?: boolean
  align?: keyof typeof ALIGN
  insetTop?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tag
      {...props}
      className={`${insetTop ? 'pt-[var(--space-2)]' : ''} flex ${ALIGN[align]} ${GAP[gap]} ${wrap ? 'flex-wrap' : ''} ${className}`}
    >
      {children}
    </Tag>
  )
}

export function InlineSpecimen(): React.JSX.Element {
  return (
    <>
      <Inline gap="small" wrap align="baseline">
        <span>Label</span>
        <span>Value</span>
      </Inline>
      <Inline gap="spacious" wrap align="start">
        <span>Code</span>
        <div>Route<br />Connection URL</div>
      </Inline>
      <p>Text with <Inline as="span" gap="small" wrap><span>a</span><span>b</span></Inline> continuing.</p>
    </>
  )
}
