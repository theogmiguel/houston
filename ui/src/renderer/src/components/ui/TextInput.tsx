import type { InputHTMLAttributes } from 'react'

export type TextInputWidth = 'md' | 'full'

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type' | 'width'> {
  type?: 'text' | 'password'
  /** Identifiers and tokens read better in the monospace face. */
  mono?: boolean
  width?: TextInputWidth
  /** Layout classes only; visual styles belong here. */
  className?: string
}

const WIDTH_CLS: Record<TextInputWidth, string> = {
  md: 'w-[200px]',
  full: 'w-full'
}

const INPUT_CLS =
  'bg-[var(--content-bg)] border border-[var(--border)] rounded-[var(--tr-radius-input)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2'

export function TextInput({ type = 'text', mono = false, width = 'md', className = '', ...props }: TextInputProps): React.JSX.Element {
  return <input {...props} type={type} className={`${INPUT_CLS} ${WIDTH_CLS[width]} ${mono ? 'font-mono' : ''} ${className}`} />
}
