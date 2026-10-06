import type { IconComponent } from '../icons'
import { IconTile } from './IconTile'
import { Button } from './Button'
import { variants } from './variants'
import { Text } from './Text'

export type EmptyStateVariant = 'panel' | 'window'

const stateClasses = variants('mx-auto flex w-full flex-col items-center text-center', {
  variant: {
    panel: 'gap-[var(--space-2)]',
    window: 'gap-[var(--space-3)]'
  }
}, { variant: 'panel' })

export interface EmptyStateProps {
  icon?: IconComponent
  heading: string
  description: string
  action?: { label: string; onClick: () => void }
  variant?: EmptyStateVariant
  fill?: boolean
  copy?: 'standard' | 'compact'
  descriptionWidth?: 'standard' | 'compact'
  className?: string
  'data-testid'?: string
}

export function EmptyState({ icon: Icon, heading, description, action, variant = 'panel', fill = false, copy = 'standard', descriptionWidth = 'standard', className = '', 'data-testid': testId }: EmptyStateProps): React.JSX.Element {
  const windowTitle = variant === 'window'
  return (
    <section data-testid={testId} className={`${stateClasses({ variant })} ${fill ? 'flex-1 min-h-0 justify-center p-6' : ''} ${className}`}>
      {Icon && <IconTile size="md" tone="muted" label={heading} icon={<Icon role="ui" />} />}
      {copy === 'compact' ? (
        <>
          <Text as="h2" flush size="ui" weight="ui" tone="primary">
            {heading}
          </Text>
          <Text as="p" size="small" tone="muted" className={descriptionWidth === 'compact' ? 'max-w-[var(--tr-empty-compact-copy-max)]' : 'max-w-[var(--tr-empty-copy-max)]'}>{description}</Text>
        </>
      ) : (
      <div className="grid justify-items-center gap-[var(--space-1)]">
        <Text as="h2" flush size={windowTitle ? undefined : 'ui'} weight={windowTitle ? undefined : 'ui'} leading={windowTitle ? undefined : 'ui'} tone="primary" className={windowTitle ? 'font-[var(--tr-text-display-weight)] [font-family:var(--tr-text-display-family)] text-[length:var(--tr-text-display-size)]' : ''}>
          {heading}
        </Text>
        <Text as="p" size="ui" leading="ui" tone="secondary" flush className={descriptionWidth === 'compact' ? 'max-w-[var(--tr-empty-compact-copy-max)]' : 'max-w-[var(--tr-empty-copy-max)]'}>{description}</Text>
      </div>
      )}
      {action && <Button variant="primary" onClick={action.onClick}>{action.label}</Button>}
    </section>
  )
}
