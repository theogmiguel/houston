import { BTN_PRIMARY } from './buttonChrome'
import { ButtonRecipe } from './ButtonRecipe'
import type { ButtonRecipeProps } from './Button'

export function OverviewButton(props: ButtonRecipeProps): React.JSX.Element {
  return <ButtonRecipe {...props} recipe={`btn ${BTN_PRIMARY} h-[var(--h-overview-answer)] min-h-[var(--h-overview-answer)] px-[var(--space-2-5)] [font-size:var(--tr-text-small-size)] flex-none`} recipeVariant="compact-primary-action" />
}
