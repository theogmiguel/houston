import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from './ContextMenu'

export function EditorContextMenu({ children, ref, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <ContextMenu {...props} ref={ref} variant="editor">{children}</ContextMenu>
}

export function EditorContextMenuItem({ children, shortcut, ref, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; shortcut?: string; ref?: Ref<HTMLButtonElement> }): React.JSX.Element {
  return <ContextMenuItem {...props} ref={ref} variant="editor" shortcut={shortcut}>{children}</ContextMenuItem>
}

export function EditorContextMenuSeparator(): React.JSX.Element {
  return <ContextMenuSeparator variant="editor" />
}
