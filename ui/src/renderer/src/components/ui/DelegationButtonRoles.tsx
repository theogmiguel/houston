import { ButtonRecipe } from './ButtonRecipe'
import type { ButtonRecipeProps } from './Button'

export function DelegationButton(props: ButtonRecipeProps): React.JSX.Element {
  return <ButtonRecipe recipe="h-[var(--h-pill)] px-2.5 inline-flex items-center gap-1.5 border border-[var(--border)] rounded-[var(--tr-radius-button)] bg-[var(--surface)] text-[var(--text-secondary)] font-[inherit] [font-size:var(--tr-text-xs)] cursor-pointer transition-[background,border-color] hover:bg-[var(--hover-fill)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:1px]" recipeVariant="legacy-focus-lever" {...props} />
}
