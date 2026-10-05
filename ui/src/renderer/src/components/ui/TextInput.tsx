import { forwardRef, type InputHTMLAttributes } from 'react'

const INPUT_CLS = 'min-h-[var(--h-ctl)] w-full rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-3)] [font-size:var(--tr-text-ui-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)]'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref): React.JSX.Element {
    return <input {...props} ref={ref} className={`${INPUT_CLS} ${props.className ?? ''}`} />
  }
)
