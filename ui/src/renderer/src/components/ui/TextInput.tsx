import type { InputHTMLAttributes } from 'react'
import { variants } from './variants'

export type TextInputWidth = 'md' | 'lg' | 'full'

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  type?: 'text' | 'password' | 'url'
  width?: TextInputWidth
  mono?: boolean
  /** Layout classes only; visual styles belong in TextInput variants. */
  className?: string
}

const inputClasses = variants(
  'h-[var(--h-ctl)] min-w-0 rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-[var(--danger)]',
  {
    width: { md: 'w-[200px]', lg: 'w-[280px]', full: 'w-full' },
    mono: { true: 'font-mono', false: '' }
  },
  { width: 'md', mono: 'false' }
)

/// A single-line text field with the settings chrome.
export function TextInput({ type = 'text', width = 'md', mono = false, className = '', ...rest }: TextInputProps): React.JSX.Element {
  return <input type={type} spellCheck={false} autoComplete="off" className={`${inputClasses({ width, mono: mono ? 'true' : 'false' })} ${className}`} {...rest} />
}
