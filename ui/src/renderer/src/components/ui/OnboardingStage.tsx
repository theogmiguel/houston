import type { ReactNode } from 'react'
import { MATERIAL_CLS, materialAttrs } from './material'
import { Text } from './Text'

/** The centred, scrollable surface that first-run and empty-workspace screens sit on. */
export function OnboardingStage({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full overflow-y-auto flex flex-col items-center justify-center gap-[var(--space-4)] p-[var(--space-onboarding-stage)] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      {children}
    </div>
  )
}

/** The step counter and skip action under an onboarding screen. */
export function OnboardingFooter({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return <div data-testid={testId} className="flex flex-col items-center gap-[var(--space-2)]">{children}</div>
}

/** A square framed glyph that leads an onboarding headline. */
export function GlyphTile({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="flex h-[var(--sz-onboarding-glyph)] w-[var(--sz-onboarding-glyph)] items-center justify-center rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)]">
      {children}
    </span>
  )
}

export function OnboardingStageSpecimen(): React.JSX.Element {
  return (
    <div data-testid="onboarding-stage-specimen" className="h-[var(--h-primitives-preview)]">
      <OnboardingStage>
        <GlyphTile>*</GlyphTile>
        <OnboardingFooter><Text size="small" tone="muted">Step 1 of 3</Text></OnboardingFooter>
      </OnboardingStage>
    </div>
  )
}
