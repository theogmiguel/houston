import type { ReactNode } from 'react'
import { Text } from './Text'

const NOTES_CLS =
  'm-0 rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-[var(--card-bg)] py-[var(--space-2-5)] px-[var(--space-3)]'

/** Release-note style text in a quiet card: a bulleted list, or free text that keeps its line breaks. */
export function NotesPanel({ list = false, children, 'data-testid': testId }: { list?: boolean; children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  if (list) {
    return <Text as="ul" size="small" tone="secondary" data-testid={testId} className={`${NOTES_CLS} grid list-disc gap-[var(--space-release-list-items)] pl-[var(--space-6)]`}>{children}</Text>
  }
  return <Text as="div" size="small" tone="secondary" data-testid={testId} className={`${NOTES_CLS} whitespace-pre-wrap break-words`}>{children}</Text>
}

export function NotesItem({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="li" breakAll className="break-words">{children}</Text>
}

/** A bordered list of one-line rows, a name on the left and an identifier on the right. */
export function InsetList({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return (
    <ul data-testid={testId} className="m-0 list-none overflow-hidden rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-[var(--card-bg)] p-0">
      {children}
    </ul>
  )
}

export function InsetRow({ primary, trailing }: { primary: ReactNode; trailing: ReactNode }): React.JSX.Element {
  return (
    <li className="grid h-[var(--h-update-session-row)] grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--space-2-5)] px-[var(--space-2-5)] [&:not(:first-child)]:border-t [&:not(:first-child)]:border-t-[var(--divider)]">
      <Text size="small" className="truncate" tone="primary">{primary}</Text>
      <Text size="small" mono tabular tone="muted">{trailing}</Text>
    </li>
  )
}

/** A disclosure that reveals supporting detail below a muted summary line. */
export function DetailsNote({ summary, children }: { summary: string; children: ReactNode }): React.JSX.Element {
  return (
    <Text as="details" size="small" tone="muted">
      <Text as="summary" className="cursor-pointer">{summary}</Text>
      <div className="pt-[var(--space-1)]">{children}</div>
    </Text>
  )
}

export function InsetPanelSpecimen(): React.JSX.Element {
  return (
    <div data-testid="inset-panel-specimen" className="grid gap-[var(--space-3)]">
      <NotesPanel list><NotesItem>Faster pane startup</NotesItem><NotesItem>Fixes a crash on resume</NotesItem></NotesPanel>
      <NotesPanel>Bug fixes and improvements.</NotesPanel>
      <InsetList><InsetRow primary="Review API changes" trailing="#1" /><InsetRow primary="Rail" trailing="#2" /></InsetList>
      <DetailsNote summary="Why sessions cannot be kept">Protocol mismatch.</DetailsNote>
    </div>
  )
}
