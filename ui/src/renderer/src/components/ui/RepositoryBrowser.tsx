import type { FormHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { TextInput } from './TextInput'
import { Button } from './Button'

function Region({ children, className, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; className: string }): React.JSX.Element {
  return <div {...props} className={className}>{children}</div>
}

export function RepositoryBrowserFrame({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex-1 min-h-0 flex flex-col ${props.className ?? ''}`}>{children}</div>
}

export function RepositoryFilterPanel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Region className="flex flex-col gap-[var(--space-2)] p-[var(--space-2-5)] border-b border-b-[var(--border)]">{children}</Region>
}

export function RepositoryFilterToolbar({ children }: { children: ReactNode }): React.JSX.Element {
  return <Region className="flex items-center gap-[var(--space-1)] flex-wrap">{children}</Region>
}

export function RepositoryFilterSpacer({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="ml-auto">{children}</span>
}

export function RepositorySearchForm({ children, ...props }: FormHTMLAttributes<HTMLFormElement>): React.JSX.Element {
  return <form {...props} className={`flex items-center gap-[var(--space-2)] ${props.className ?? ''}`}>{children}</form>
}

export function RepositorySearchField(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'width' | 'size' | 'height'>): React.JSX.Element {
  return <TextInput {...props} font="small" padding="compact" className={`h-[var(--h-ctl)] flex-1 min-w-0 focus-visible:outline-none focus-visible:border-[var(--border-focus)] ${props.className ?? ''}`} />
}

export function RepositoryResultList({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin] ${props.className ?? ''}`}>{children}</div>
}

export function RepositoryLoadingState({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex items-center justify-center p-[var(--space-6)] ${props.className ?? ''}`}>{children}</div>
}

export function RepositoryErrorMessage({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <Text {...props} as="div" size="small" tone="danger" className="p-[var(--space-3)] break-words [overflow-wrap:anywhere]">{children}</Text>
}

export function RepositoryEmptyMessage({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <Text {...props} as="div" size="small" tone="muted" className="p-[var(--space-3)]">{children}</Text>
}

export function RepositoryRowHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return <Region className="flex items-center gap-[var(--space-2)]">{children}</Region>
}

export function RepositoryNumber({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" mono tone="faint" className="flex-none">{children}</Text>
}

export function RepositoryTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="ui" tone="primary" className="flex-1 min-w-0 truncate">{children}</Text>
}

export function RepositoryStateLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="muted" className="flex-none">{children}</Text>
}

export function RepositoryRowMeta({ children }: { children: ReactNode }): React.JSX.Element {
  return <Region className="flex items-center gap-[var(--space-2)]">{children}</Region>
}

export function RepositoryRefSummary({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="faint" className="min-w-0 truncate">{children}</Text>
}

export function RepositoryLabels({ children }: { children: ReactNode }): React.JSX.Element {
  return <Region className="flex items-center gap-[var(--space-1)] flex-wrap">{children}</Region>
}

export function RepositoryLoadMoreRegion({ children }: { children: ReactNode }): React.JSX.Element {
  return <Region className="p-[var(--space-2-5)] border-t border-t-[var(--divider)]">{children}</Region>
}

export function RepositoryBrowserSpecimen(): React.JSX.Element {
  return <RepositoryBrowserFrame><RepositoryFilterPanel><RepositoryFilterToolbar><Button variant="outline">Open</Button><RepositoryFilterSpacer><Button variant="outline">Mine</Button></RepositoryFilterSpacer></RepositoryFilterToolbar><RepositorySearchForm><RepositorySearchField aria-label="Search repositories" placeholder="Search" /><Button variant="compact-control">Search</Button></RepositorySearchForm></RepositoryFilterPanel><RepositoryResultList><Button variant="repository-list-row"><RepositoryRowHeading><RepositoryNumber>#42</RepositoryNumber><RepositoryTitle>Keep browser sessions grouped</RepositoryTitle><RepositoryStateLabel>Open</RepositoryStateLabel></RepositoryRowHeading><RepositoryRowMeta><RepositoryRefSummary>theo · feature → main</RepositoryRefSummary><span>passing</span></RepositoryRowMeta><RepositoryLabels><span>bug</span><span>review</span></RepositoryLabels></Button></RepositoryResultList><RepositoryLoadMoreRegion><Button variant="repository-load-more-action">Load more</Button></RepositoryLoadMoreRegion></RepositoryBrowserFrame>
}
