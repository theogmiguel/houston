import { BTN_GHOST, BTN_SECONDARY } from './buttonChrome'
import { ButtonRecipe } from './ButtonRecipe'
import type { ButtonRecipeProps } from './Button'

const RECIPES = {
  'legacy-secondary': BTN_SECONDARY,
  'legacy-ghost-icon': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`,
  'legacy-ghost-icon-danger': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`,
  'legacy-ghost-disclosure': `btn ${BTN_GHOST} -ml-2.5 flex items-center gap-1 text-[length:var(--tr-text-base)]`,
  'legacy-bare-ghost': BTN_GHOST
} as const

export type LazyLegacyButtonVariant = keyof typeof RECIPES

export function LazyLegacyButton({ variant, ...props }: ButtonRecipeProps & { variant: LazyLegacyButtonVariant }): React.JSX.Element {
  return <ButtonRecipe {...props} recipe={RECIPES[variant]} recipeVariant={variant} dropHead={variant === 'legacy-bare-ghost'} />
}
