import type { ReactNode } from 'react'
import { Text, type TextProps } from './Text'

export function SingleLineText({ children, className = '', ...props }: TextProps & { children?: ReactNode }): React.JSX.Element {
  return <Text {...props} className={`whitespace-nowrap ${className}`}>{children}</Text>
}
