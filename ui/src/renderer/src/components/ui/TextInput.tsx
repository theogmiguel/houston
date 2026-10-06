import { forwardRef, type InputHTMLAttributes } from 'react'

export type TextInputWidth = 'md' | 'full'

const INPUT_CLS = 'min-h-[var(--h-ctl)] rounded-[var(--tr-radius-input)] border border-[var(--border)] px-[var(--space-3)] [font-size:var(--tr-text-ui-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)]'
const WIDTH_CLS: Record<TextInputWidth, string> = {
  md: 'w-[200px]',
  full: 'w-full'
}
export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'width'> & { surface?: 'content' | 'card'; font?: 'ui' | 'mono'; width?: TextInputWidth }

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(props, ref): React.JSX.Element {
    const { className = '', surface = 'content', font = 'ui', width = 'full', ...inputProps } = props
    return <input {...inputProps} ref={ref} className={`${INPUT_CLS} ${WIDTH_CLS[width]} ${surface === 'card' ? 'bg-[var(--card-bg)]' : 'bg-[var(--content-bg)]'} ${font === 'mono' ? 'font-mono' : ''} ${className}`} />
  }
)
