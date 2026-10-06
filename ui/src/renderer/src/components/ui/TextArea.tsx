import type { ComponentType, TextareaHTMLAttributes } from 'react'
import { variants } from './variants'
import { Text, type TextProps } from './Text'

const TextareaText = Text as ComponentType<TextProps & TextareaHTMLAttributes<HTMLTextAreaElement>>

const textareaClasses = variants('w-full resize-none rounded-[var(--tr-radius-input)] border border-[var(--border)] px-2 py-1.5 text-[length:var(--tr-text-small-size)] placeholder:text-[var(--text-faint)] focus-visible:outline-none focus-visible:border-[var(--border-focus)]', {
  surface: {
    background: 'bg-[var(--background)]',
    content: 'bg-[var(--content-bg)]'
  }
}, { surface: 'content' })

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  surface?: 'background' | 'content'
}

export function TextArea({ surface = 'content', className = '', ...props }: TextAreaProps): React.JSX.Element {
  return <TextareaText {...props} as="textarea" size="small" tone="primary" className={`${textareaClasses({ surface })} ${className}`} />
}
