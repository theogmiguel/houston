import { BTN_GHOST, BTN_GHOST_DANGER_HOVER } from './buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { ButtonRecipe } from './ButtonRecipe'
import type { ButtonRecipeProps } from './Button'

const RECIPES = {
  'compact-primary': 'min-h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-form-button-gap)] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110 disabled:opacity-55',
  'compact-secondary': 'min-h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-form-button-gap)] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default border border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:bg-[var(--selected-fill)] hover:text-[var(--text-primary)] disabled:opacity-55',
  'compact-icon-danger': `flex-none w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer [transition:color_0.1s_ease-out,background-color_0.1s_ease-out] hover:not-disabled:bg-[var(--hover-fill)] hover:not-disabled:text-[var(--danger)] disabled:text-[var(--text-faint)] disabled:opacity-55 disabled:cursor-default ${HIT_TARGET_28}`,
  'compact-ghost': `btn ${BTN_GHOST} px-[var(--space-2)]`,
  'compact-danger': `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER} px-[var(--space-2)]`,
  'label-action': `btn ${BTN_GHOST} px-1.5 py-0 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]`,
  'accent-soft': 'rounded-[var(--tr-radius-sm)] border border-[var(--accent)] bg-[var(--accent-muted)] px-[var(--tr-space-profile-action-inline)] py-[var(--tr-space-profile-action-block)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--accent)] hover:brightness-110 disabled:opacity-40 disabled:cursor-default'
} as const

export type SettingsButtonVariant = keyof typeof RECIPES

export function SettingsButton({ variant, ...props }: ButtonRecipeProps & { variant: SettingsButtonVariant }): React.JSX.Element {
  return <ButtonRecipe {...props} recipe={RECIPES[variant]} recipeVariant={variant} />
}
