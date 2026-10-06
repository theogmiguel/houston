import type { ReactNode } from 'react'
import { IconClose } from '../icons'
import { Icon } from './Icon'
import { QuietButton } from './QuietButton'
import { Text } from './Text'

/** A dismissible notice pinned to the top centre of the nearest positioned ancestor. */
export function FloatingBanner({ children, onDismiss, 'data-testid': testId }: { children: ReactNode; onDismiss: () => void; 'data-testid'?: string }): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      role="status"
      className="absolute top-3 left-1/2 -translate-x-1/2 z-[var(--z-overlay)] flex items-center gap-3 rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] shadow-[var(--shadow-md)] px-3.5 py-2 max-w-[var(--w-floating-banner)]"
    >
      <Text size="small" weight="small" tone="secondary">{children}</Text>
      <QuietButton variant="dismiss" aria-label="Dismiss" onClick={onDismiss}>
        <Icon glyph={IconClose} role="small" />
      </QuietButton>
    </div>
  )
}

export function FloatingBannerSpecimen(): React.JSX.Element {
  return (
    <div data-testid="floating-banner-specimen" className="relative h-[var(--h-primitives-preview-short)]">
      <FloatingBanner onDismiss={() => {}}>A short notice with a dismiss control.</FloatingBanner>
    </div>
  )
}
