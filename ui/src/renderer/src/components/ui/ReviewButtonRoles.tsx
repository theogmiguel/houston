import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from './buttonChrome'
import { RING_ACCENT_INSET_18 } from './shadowChrome'
import { ButtonRecipe } from './ButtonRecipe'
import type { ButtonRecipeProps } from './Button'

const RECIPES = {
  'picker-candidate': 'w-full min-h-0 flex items-center gap-[var(--space-2)] px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-0 rounded-none text-left [font-size:inherit] [font-weight:inherit] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] disabled:opacity-55 hover:enabled:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:bg-[var(--card-hover)]',
  'primary-action': `btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-55`,
  'secondary-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)]`,
  'picker-done-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] ml-auto`,
  'repository-list-row': 'w-full min-h-0 flex flex-col items-stretch gap-[var(--space-0-5)] px-[var(--space-2-5)] py-[var(--space-2)] bg-transparent border-0 border-t border-t-[var(--divider)] first:border-t-0 rounded-none text-left [font-size:inherit] [font-weight:inherit] hover:enabled:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:bg-[var(--card-hover)]',
  'file-retry-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] justify-start`,
  reaction: 'inline-flex items-center gap-[var(--space-1)] h-[var(--h-ctl-mini)] px-1.5 rounded-[var(--tr-radius-pill)] border text-[length:var(--tr-text-small-size)] disabled:opacity-55',
  'reaction-option': `btn ${BTN_GHOST} inline-flex items-center justify-center h-[var(--h-ctl-mini)] px-1 leading-none disabled:opacity-55`,
  'agent-option': 'flex h-[var(--tr-agent-option-height)] items-center gap-[var(--tr-agent-option-gap)] rounded-[var(--tr-radius-button)] border text-left px-[var(--space-2-5)] pl-[var(--space-2-5)] pr-[var(--space-2)] transition-[border-color,background-color,color] duration-150',
  'diff-line-action': `btn ${BTN_GHOST} flex-none inline-flex items-center px-1 leading-none text-[var(--text-muted)] hover:enabled:text-[var(--text-primary)] disabled:opacity-55`,
  'compact-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1-5)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] disabled:opacity-55`,
  'compact-self-start-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] self-start px-[var(--space-1)] text-[var(--text-muted)]`,
  'compact-trailing-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1-5)] ml-auto text-[var(--text-muted)] disabled:opacity-55`,
  'compact-control': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl)] px-[var(--space-2)]`,
  'discussion-edit-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] disabled:opacity-55`,
  'discussion-reply-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-55`,
  'pull-request-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-45 disabled:cursor-not-allowed`,
  'pull-request-danger-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_42%,var(--border))] disabled:opacity-45 disabled:cursor-not-allowed`,
  'pull-request-primary-action': `btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-45 disabled:cursor-not-allowed`,
  'pull-request-nav-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)]`,
  'pull-request-external-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] ml-auto`
} as const

export type ReviewButtonVariant = keyof typeof RECIPES

const SELECTED = {
  reaction: 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text-primary)]',
  'agent-option': `border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--card-bg))] shadow-[${RING_ACCENT_INSET_18}] text-[var(--text-primary)]`,
  'diff-line-action': 'text-[var(--accent)]'
} as const

const UNSELECTED = {
  reaction: 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:enabled:text-[var(--text-primary)]',
  'agent-option': 'border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-muted)] hover:enabled:border-[var(--text-faint)]'
} as const

export function ReviewButton({ variant, ...props }: ButtonRecipeProps & { variant: ReviewButtonVariant }): React.JSX.Element {
  return (
    <ButtonRecipe
      {...props}
      recipe={RECIPES[variant]}
      recipeVariant={variant}
      selectedClass={SELECTED[variant as keyof typeof SELECTED]}
      unselectedClass={UNSELECTED[variant as keyof typeof UNSELECTED]}
    />
  )
}
