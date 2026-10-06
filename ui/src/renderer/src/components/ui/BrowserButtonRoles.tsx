import { ButtonRecipe } from './ButtonRecipe'
import type { ButtonRecipeProps } from './Button'

const RECIPES = {
  outline: 'border-[var(--border)] bg-transparent text-[var(--text-primary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--hover-fill)]',
  label: 'h-auto min-h-0 border-0 bg-transparent p-0 text-left [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:0.06em] uppercase text-[var(--text-muted)] hover:enabled:bg-transparent hover:enabled:text-[var(--text-primary)]'
} as const

export type BrowserButtonVariant = keyof typeof RECIPES

export function BrowserButton({ variant, ...props }: ButtonRecipeProps & { variant: BrowserButtonVariant }): React.JSX.Element {
  return <ButtonRecipe {...props} recipe={RECIPES[variant]} recipeVariant={variant} standardSize={variant === 'outline'} />
}
