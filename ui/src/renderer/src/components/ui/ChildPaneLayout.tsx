import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { BTN_GHOST, BTN_ICO_STRUCTURE } from './buttonChrome'
import { Text } from './Text'
export function ChildrenColumn({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-w-0 min-h-0 flex flex-col">{children}</div>
}

export function PeekBarButton({ shrink = false, ...rest }: { shrink?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...rest} className={`btn border-none bg-transparent min-h-[var(--h-ctl)] ${shrink ? 'shrink-0' : 'truncate'}`} />
}

export function PeekBarIconButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${BTN_ICO_STRUCTURE} min-w-[var(--h-ctl)] min-h-[var(--h-ctl)]`} />
}

/** The footer under a settled child's terminal. */
export function SettledChildFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text
      as="footer"
      aria-label="Settled child"
      size="small" tone="muted"
      className="absolute inset-x-0 bottom-0 flex items-center flex-wrap gap-[var(--space-1)] px-[var(--space-2)] py-[var(--space-1)] border-t border-[var(--divider)] bg-[var(--card-bg)]"
    >
      {children}
    </Text>
  )
}

export function SettledChildButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button {...props} className={`${BTN_GHOST} btn min-h-[var(--h-ctl)] shrink-0`} />
}

/** The dismissible note under the header that says why a pane started fresh. */
