import type { ReactNode } from 'react'
import { IconChevronRight } from '../icons'
import { Icon } from './Icon'
import { TextInput } from './TextInput'
import { Text } from './Text'

/** A two-column form: right-aligned labels in a content-sized column, controls in the flexible one. */
export function FormGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 items-center">{children}</div>
}

export function FormGridLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }): React.JSX.Element {
  return <Text as="label" size="base" tone="primary" htmlFor={htmlFor} className="text-right">{children}</Text>
}

/** A right-pointing chevron that turns downward while its section is open. */
export function DisclosureChevron({ open }: { open: boolean }): React.JSX.Element {
  return <span className={open ? 'rotate-90' : ''}><Icon glyph={IconChevronRight} role="ui" /></span>
}

export function FormGridSpecimen(): React.JSX.Element {
  return (
    <div data-testid="form-grid-specimen">
      <FormGrid>
        <FormGridLabel htmlFor="specimen-machine">Machine</FormGridLabel>
        <TextInput variant="form" value="server" readOnly />
        <FormGridLabel htmlFor="specimen-port">Port</FormGridLabel>
        <TextInput variant="form" width="port" value="22" readOnly />
        <FormGridLabel htmlFor="specimen-advanced">Advanced</FormGridLabel>
        <span className="flex gap-[var(--space-2)]"><DisclosureChevron open={false} /><DisclosureChevron open /></span>
      </FormGrid>
    </div>
  )
}
