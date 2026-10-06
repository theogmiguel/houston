import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

export function Readout({ label, value, sub, mono = false, tabular = false, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { label: ReactNode; value: ReactNode; sub?: ReactNode; mono?: boolean; tabular?: boolean }): React.JSX.Element {
  return (
    <div {...props} className={`flex flex-col gap-[var(--tr-readout-label-gap)] rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-2-5)] py-[var(--space-2)] ${className}`}>
      <Text as="div" size="small" weight="medium" tone="muted">{label}</Text>
      <Text as="div" size={mono ? 'small' : 'ui'} weight="medium" tone="primary" mono={mono} tabular={tabular} breakAll={mono}>{value}</Text>
      {sub !== undefined && <Text as="div" size="small" weight="medium" tone="faint">{sub}</Text>}
    </div>
  )
}

export function ReadoutGrid({ children, className = '', spaceAfter = false, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; spaceAfter?: boolean }): React.JSX.Element {
  return <div {...props} className={`${spaceAfter ? 'pb-[var(--tr-readout-grid-following-space)]' : ''} grid grid-cols-2 gap-[var(--space-2-5)] ${className}`}>{children}</div>
}
