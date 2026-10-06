import type { ReactNode } from 'react'

export function DiffLoadingMark({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="loop-anim motion-safe:animate-[git-spin_0.9s_linear_infinite]">{children}</span>
}
