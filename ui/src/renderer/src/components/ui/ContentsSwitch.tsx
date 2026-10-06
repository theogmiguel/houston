import type { HTMLAttributes, ReactNode } from 'react'

/** Shows children without a box, or removes them from layout while keeping them mounted. */
export function ContentsSwitch({ shown, children, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, 'className'> & { shown: boolean; children: ReactNode }): React.JSX.Element {
  return <div {...rest} className={shown ? 'contents' : 'hidden'}>{children}</div>
}

export function ContentsSwitchSpecimen(): React.JSX.Element {
  return <div data-testid="contents-switch-specimen"><ContentsSwitch shown><span>Visible contents</span></ContentsSwitch></div>
}
