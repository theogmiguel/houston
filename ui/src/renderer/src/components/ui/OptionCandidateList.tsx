import { ReviewButton } from './ReviewButtonRoles'
import type { HTMLAttributes, ReactNode } from 'react'

export function OptionCandidateList({ children, scrollable = true, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; scrollable?: boolean }): React.JSX.Element {
  return <div {...props} className={`${scrollable ? 'max-h-[var(--tr-picker-list-max-height)] overflow-y-auto [scrollbar-width:thin]' : ''} border border-[var(--border)] rounded-[var(--tr-radius-sm)] overflow-hidden flex flex-col bg-[var(--content-bg)] ${props.className ?? ''}`}>{children}</div>
}

export function OptionCandidateListSpecimen(): React.JSX.Element {
  return <OptionCandidateList><ReviewButton variant="picker-candidate">Candidate</ReviewButton><ReviewButton variant="picker-candidate">Another candidate</ReviewButton></OptionCandidateList>
}
