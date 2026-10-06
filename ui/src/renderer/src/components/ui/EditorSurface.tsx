import type { HTMLAttributes, Ref, ReactNode } from 'react'
import { Text } from './Text'
import './editorHost.css'

export function EditorHost({ ref, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div {...props} ref={ref} className={`absolute inset-0 [&_.cm-editor]:h-full ${props.className ?? ''}`} />
}

export function EditorStatus({ children, variant = 'normal', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; variant?: 'normal' | 'error' }): React.JSX.Element {
  return <Text {...props} as="div" size="caption" weight="label" tone={variant === 'error' ? undefined : 'muted'} className={`py-1 px-2.5 border-b border-[var(--border)] flex-none cursor-default ${variant === 'error' ? 'text-[var(--status-blocked-text)] bg-[var(--status-blocked-bg)]' : ''} ${props.className ?? ''}`}>{children}</Text>
}
