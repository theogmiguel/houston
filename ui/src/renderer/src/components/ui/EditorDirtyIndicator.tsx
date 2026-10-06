export function EditorDirtyIndicator(props: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...props} className={`flex-none h-[var(--sz-editor-dirty-indicator)] w-[var(--sz-editor-dirty-indicator)] rounded-full bg-[var(--warning)] ${props.className ?? ''}`} />
}
