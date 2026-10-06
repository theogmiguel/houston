import { forwardRef, type InputHTMLAttributes } from 'react'

export type TextInputWidth = 'md' | 'full' | 'port' | 'setting-number' | 'task-number'

const INPUT_CLS = 'min-h-[var(--h-ctl)] rounded-[var(--tr-radius-input)] border border-[var(--border)] px-[var(--space-3)] [font-size:var(--tr-text-ui-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)]'
const WIDTH_CLS: Record<TextInputWidth, string> = {
  md: 'w-[var(--w-text-input-medium)]',
  full: 'w-full',
  port: 'w-[var(--w-ssh-port)] tabular-nums',
  'setting-number': 'w-[var(--tr-width-setting-number)]',
  'task-number': 'w-[var(--tr-width-task-number)]'
}
const FORM_CLS = 'w-full min-w-0 h-[var(--h-ssh-input)] px-[var(--space-2-5)] bg-background border border-border rounded-[var(--tr-radius-sm)] text-text-primary text-[length:var(--tr-text-base)]'
export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'width'> & { surface?: 'content' | 'card'; font?: 'ui' | 'mono'; width?: TextInputWidth; variant?: 'field' | 'form' | 'unstyled' | 'compact' | 'setting-number' | 'setting-number-rounded' | 'task-number' }

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(props, ref): React.JSX.Element {
    const { className = '', surface = 'content', font = 'ui', width = 'full', variant = 'field', ...inputProps } = props
    if (variant === 'form') {
      return <input {...inputProps} ref={ref} className={`${FORM_CLS} ${width === 'port' ? 'w-[var(--w-ssh-port)] tabular-nums' : ''} ${className}`} />
    }
    if (variant === 'unstyled') return <input {...inputProps} ref={ref} className={className} />
    if (variant === 'compact' || variant === 'setting-number' || variant === 'setting-number-rounded' || variant === 'task-number') {
      const widthVariant = variant === 'task-number' ? 'task-number' : variant === 'compact' ? 'full' : 'setting-number'
      const widthClass = WIDTH_CLS[widthVariant]
      const radiusClass = variant === 'task-number' ? 'rounded-[var(--tr-radius-input)]' : 'rounded-[var(--tr-radius-sm)]'
      const stateClass = variant === 'compact'
        ? 'disabled:opacity-50'
        : variant === 'setting-number-rounded'
          ? 'text-right disabled:opacity-50'
          : 'text-right'
      return <input {...inputProps} ref={ref} className={`${widthClass} border border-[var(--border)] ${radiusClass} bg-[var(--content-bg)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[var(--tr-space-compact-field-block)] px-[var(--space-2)] ${stateClass} ${className}`} />
    }
    return <input {...inputProps} ref={ref} className={`${INPUT_CLS} ${WIDTH_CLS[width]} ${surface === 'card' ? 'bg-[var(--card-bg)]' : 'bg-[var(--content-bg)]'} ${font === 'mono' ? 'font-mono' : ''} ${className}`} />
  }
)
