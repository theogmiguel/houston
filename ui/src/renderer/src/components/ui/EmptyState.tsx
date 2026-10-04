import type { IconComponent } from '../icons'
import { IconTile } from '../IconTile'
import { Button } from './Button'
import { variants } from './variants'

export type EmptyStateVariant = 'panel' | 'window'

const stateClasses = variants('mx-auto flex w-full flex-col items-center text-center', {
  variant: {
    panel: 'gap-[var(--space-2)]',
    window: 'gap-[var(--space-3)]'
  }
}, { variant: 'panel' })

export interface EmptyStateProps {
  icon: IconComponent
  heading: string
  description: string
  action?: { label: string; onClick: () => void }
  variant?: EmptyStateVariant
  className?: string
}

export function EmptyState({ icon: Icon, heading, description, action, variant = 'panel', className = '' }: EmptyStateProps): React.JSX.Element {
  const windowTitle = variant === 'window'
  return (
    <section className={`${stateClasses({ variant })} ${className}`}>
      <IconTile size="md" tone="muted" label={heading} icon={<Icon role="ui" />} />
      <div className="grid justify-items-center gap-[var(--space-1)]">
        <h2 className={windowTitle
          ? 'm-0 font-[var(--tr-text-display-weight)] [font-family:var(--tr-text-display-family)] text-[length:var(--tr-text-display-size)] text-[var(--text-primary)]'
          : 'm-0 text-[length:var(--tr-text-ui-size)] font-[var(--tr-text-ui-weight)] leading-[var(--tr-text-ui-leading)] text-[var(--text-primary)]'}>
          {heading}
        </h2>
        <p className="m-0 max-w-[48ch] text-[length:var(--tr-text-ui-size)] leading-[var(--tr-text-ui-leading)] text-[var(--text-secondary)]">{description}</p>
      </div>
      {action && <Button variant="primary" onClick={action.onClick}>{action.label}</Button>}
    </section>
  )
}
