import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'

export function TagSwatchDot({ color, size }: { color: string; size: 'menu' | 'row' }): React.JSX.Element {
  const dimension = size === 'menu' ? 'var(--sz-tag-swatch-menu)' : 'var(--sz-tag-swatch-row)'
  return <span aria-hidden className="rounded-full flex-none" style={{ background: color, width: dimension, height: dimension }} />
}

export function TagSwatchGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap gap-[var(--space-tag-picker-gap)]" data-testid="tag-color-picker">{children}</div>
}

export function TagSwatchButton({
  color,
  selected,
  ...rest
}: { color: string; selected: boolean } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...rest}
      type="button"
      aria-pressed={selected}
      className={`${CONTROL_SIZE_SQUARE_CLS.mini} rounded-full cursor-default ${selected ? 'outline outline-1 outline-offset-2 outline-[var(--text-primary)]' : 'hover:brightness-110'}`}
      style={{ background: color }}
    />
  )
}
