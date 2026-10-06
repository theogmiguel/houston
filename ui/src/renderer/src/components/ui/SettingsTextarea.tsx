import type { TextareaHTMLAttributes } from 'react'
import { TextArea, type TextAreaProps } from './TextArea'

/** A settings-row textarea; widths match `TextInput` so a field column lines up. */
export function SettingsTextarea({ width = 'full', surface = 'content', radius = 'input', mono = false, resizable = false, className = '', ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'cols'> & {
  width?: TextAreaProps['width']
  surface?: 'content' | 'card'
  radius?: 'input' | 'small'
  mono?: boolean
  resizable?: boolean
}): React.JSX.Element {
  return <TextArea {...props} recipe="settings" width={width} surface={surface} radius={radius} mono={mono} resizable={resizable} className={className} />
}
