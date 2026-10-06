import type { HTMLAttributes, ReactNode } from 'react'
import { Button } from './Button'
import { Text } from './Text'

export function FileRetryPanel({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex flex-col gap-[var(--space-2)] p-[var(--space-3)] ${props.className ?? ''}`}>{children}</div>
}

export function FileErrorMessage({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="danger" className="break-words [overflow-wrap:anywhere]">{children}</Text>
}

export function EmptyFilesMessage({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" tone="muted" className="p-[var(--space-3)]">{children}</Text>
}

export function FilePanelMessageSpecimen(): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-2)]"><FileRetryPanel><FileErrorMessage>The diff could not be read.</FileErrorMessage><Button variant="file-retry-action">Retry</Button></FileRetryPanel><EmptyFilesMessage>No files changed.</EmptyFilesMessage></div>
}
