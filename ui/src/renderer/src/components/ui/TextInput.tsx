import { forwardRef, type InputHTMLAttributes } from 'react'

const INPUT_CLS = 'min-h-[var(--h-ctl)] w-full rounded-[var(--tr-radius-input)] border border-[var(--border)] px-[var(--space-3)] [font-size:var(--tr-text-ui-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)]'
type TextInputProps = InputHTMLAttributes<HTMLInputElement> & { surface?: 'content' | 'card'; font?: 'ui' | 'mono' }

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(props, ref): React.JSX.Element {
    const { className = '', surface = 'content', font = 'ui', ...inputProps } = props
    return <input {...inputProps} ref={ref} className={`${INPUT_CLS} ${surface === 'card' ? 'bg-[var(--card-bg)]' : 'bg-[var(--content-bg)]'} ${font === 'mono' ? 'font-mono' : ''} ${className}`} />
  }
)
