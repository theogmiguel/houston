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

const FIELD_TEXTAREA = 'w-full min-h-[var(--h-form-textarea-min)] resize-y px-[var(--space-field-control-inline)] py-[var(--space-form-textarea-block)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.5] text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[0.72]'
const PANEL_TEXTAREA = 'w-full min-h-[var(--h-panel-textarea-min)] resize-y px-[var(--space-panel-control-x)] py-[var(--space-panel-textarea-y)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] [line-height:var(--tr-text-ui-leading)] text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[var(--panel-disabled-opacity)]'
const PANE_TEXTAREA = 'w-full bg-[var(--panel-field-fill)] border border-[var(--panel-field-border)] text-text-primary outline-none focus:border-[var(--border-hover)] focus:bg-surface focus-visible:border-[var(--border-hover)] min-h-[var(--h-pane-editor)] resize-y py-3 px-3 rounded-[var(--tr-radius-card)] font-mono [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[var(--tr-text-editor-leading)]'
const WIDTH = { compact: 'w-[var(--tr-control-width-compact)]', number: 'w-[var(--tr-control-width-number)]', medium: 'w-[var(--tr-control-width-medium)]', long: 'w-[var(--tr-control-width-long)]', wide: 'w-[var(--tr-control-width-wide)]', full: 'w-full' } as const

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  surface?: 'background' | 'content' | 'card'
  recipe?: 'default' | 'settings' | 'field' | 'panel' | 'pane'
  width?: keyof typeof WIDTH
  radius?: 'input' | 'small'
  mono?: boolean
  resizable?: boolean
  fill?: boolean
}

export function TextArea({ surface = 'content', recipe = 'default', width = 'full', radius = 'input', mono = false, resizable = false, fill = false, className = '', ...props }: TextAreaProps): React.JSX.Element {
  if (recipe === 'default') return <TextareaText {...props} as="textarea" size="small" tone="primary" className={`${textareaClasses({ surface: surface === 'background' ? 'background' : 'content' })} ${className}`} />
  if (recipe === 'settings') return <textarea {...props} className={`${WIDTH[width]} ${radius === 'small' ? 'rounded-[var(--tr-radius-sm)]' : 'rounded-[var(--tr-radius-input)]'} border border-[var(--border)] ${surface === 'card' ? 'bg-[var(--card-bg)]' : 'bg-[var(--content-bg)]'} text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[var(--tr-text-ui-leading)] ${mono ? 'font-mono' : ''} py-[var(--space-1-5)] px-[var(--space-2)] ${resizable ? 'resize-y' : ''} ${className}`} />
  if (recipe === 'field') return <textarea {...props} className={`${FIELD_TEXTAREA} ${className}`} />
  if (recipe === 'panel') return <textarea {...props} className={`${PANEL_TEXTAREA} ${fill ? 'flex-1 min-h-0 font-mono' : ''} ${className}`} />
  return <textarea {...props} className={`${PANE_TEXTAREA} ${className}`} />
}
