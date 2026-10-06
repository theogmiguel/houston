import type { HTMLAttributes } from 'react'

export function Viewport(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} style={{ height: 'var(--h-viewport)', ...props.style }} />
}
