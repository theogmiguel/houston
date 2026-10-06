import type { ReactNode } from 'react'
import { FOCUS_HALO } from './shadowChrome'
import { Text } from './Text'

export function DetailsDisclosure({ summary, children }: { summary: string; children: ReactNode }): React.JSX.Element {
  return <details data-testid="background-advanced" className="border border-[var(--border)] rounded-[var(--tr-radius-md)] bg-[var(--card-bg)] overflow-hidden [&[open]>summary]:border-b [&[open]>summary]:border-b-[var(--divider)]">
    <summary className={`flex cursor-pointer list-none items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-secondary)] marker:content-none [&::-webkit-details-marker]:hidden focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] hover:text-[var(--text-primary)]`}>
      <span aria-hidden className="text-[var(--text-faint)] [font-size:var(--tr-text-label-size)]">&#9656;</span>
      <Text size="ui" weight="medium" tone="secondary">{summary}</Text>
    </summary>
    {children}
  </details>
}

export function LimitTag({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex-none rounded-[var(--tr-radius-input)] border border-[var(--divider)] px-[var(--space-1)] font-mono [font-size:var(--tr-text-label-size)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">{children}</span>
}

export function DetailsDisclosureSpecimen(): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-2)]"><DetailsDisclosure summary="More settings"><Text as="p" size="small" tone="muted">Additional options.</Text></DetailsDisclosure><LimitTag>max 44%</LimitTag></div>
}
