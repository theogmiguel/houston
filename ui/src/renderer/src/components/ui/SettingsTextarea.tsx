import type { TextareaHTMLAttributes } from 'react'

const WIDTH = {
  compact: 'w-[var(--tr-control-width-compact)]',
  number: 'w-[var(--tr-control-width-number)]',
  medium: 'w-[var(--tr-control-width-medium)]',
  long: 'w-[var(--tr-control-width-long)]',
  wide: 'w-[var(--tr-control-width-wide)]',
  full: 'w-full'
} as const

/** A settings-row textarea; widths match `TextInput` so a field column lines up. */
export function SettingsTextarea({ width = 'full', surface = 'content', radius = 'input', mono = false, resizable = false, className = '', ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'cols'> & {
  width?: keyof typeof WIDTH
  surface?: 'content' | 'card'
  radius?: 'input' | 'small'
  mono?: boolean
  resizable?: boolean
}): React.JSX.Element {
  return <textarea {...props} className={`${WIDTH[width]} ${radius === 'small' ? 'rounded-[var(--tr-radius-sm)]' : 'rounded-[var(--tr-radius-input)]'} border border-[var(--border)] ${surface === 'card' ? 'bg-[var(--card-bg)]' : 'bg-[var(--content-bg)]'} text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[var(--tr-text-ui-leading)] ${mono ? 'font-mono' : ''} py-[var(--space-1-5)] px-[var(--space-2)] ${resizable ? 'resize-y' : ''} ${className}`} />
}
