import type { ReactNode } from 'react'
import { Text } from './Text'

export function SidePanelRow({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return <div className="side-panel-row flex-1 min-w-0 min-h-0 flex" data-testid={testId}>{children}</div>
}

export function SidePanelRowSpecimen(): React.JSX.Element {
  return <div data-testid="side-panel-row-specimen" className="flex h-[var(--h-primitives-preview-short)]"><SidePanelRow><Text>Side panel content</Text></SidePanelRow></div>
}
