import type { ReactNode } from 'react'
import { IconChevronRight } from '../icons'
import { Icon } from './Icon'
import { Text } from './Text'
import { ROW_STATE } from './rowState'
export function SettingsDisclosure({ heading, detail, status, children, open = false }: { heading: ReactNode; detail?: ReactNode; status?: ReactNode; children: ReactNode; open?: boolean }): React.JSX.Element {
  return <details open={open || undefined} className="group [&+&]:border-t [&+&]:border-[var(--divider)]"><summary className={`flex cursor-pointer list-none items-center gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] [&::-webkit-details-marker]:hidden focus-visible:outline focus-visible:outline-[var(--border-focus)] ${ROW_STATE.rest}`}><span className="flex-none group-open:rotate-90"><Icon glyph={IconChevronRight} role="small" /></span><span className="grid min-w-0 flex-1 gap-[var(--space-1)]"><Text size="ui" weight="medium">{heading}</Text>{detail && <Text size="small" tone="muted">{detail}</Text>}</span>{status}</summary><div className="grid gap-[var(--space-3)] border-t border-[var(--divider)] bg-[var(--content-bg)] px-[var(--space-4)] py-[var(--space-3)]">{children}</div></details>
}
