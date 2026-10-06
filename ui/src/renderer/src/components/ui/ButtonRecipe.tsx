import type { ButtonRecipeProps } from './Button'
import { ButtonFrame } from './Button'

const BUTTON_HEAD = 'btn inline-flex items-center justify-center disabled:cursor-not-allowed'
const SIZE_CLASSES = {
  md: 'h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-1-5)]',
  sm: 'h-[var(--h-ctl-mini)] px-[var(--space-2)] gap-[var(--space-1-5)]',
  lg: 'h-[var(--h-empty-action)] px-[var(--space-5)] gap-[var(--space-2)]'
} as const

export function ButtonRecipe({
  recipe,
  recipeVariant,
  chromeClass = '',
  dropHead = false,
  standardSize = false,
  selected = false,
  selectedClass = '',
  unselectedClass = '',
  ...props
}: ButtonRecipeProps & {
  recipe: string
  recipeVariant: string
  chromeClass?: string
  dropHead?: boolean
  standardSize?: boolean
  selected?: boolean
  selectedClass?: string
  unselectedClass?: string
}): React.JSX.Element {
  const { className = '', contentAlign = 'center', noDrag = false } = props
  const structure = `${dropHead ? '' : `${BUTTON_HEAD} `}${recipe}${standardSize ? ` ${SIZE_CLASSES[props.size ?? 'md']}` : ''}`
  const aligned = contentAlign === 'start' ? structure.replace(' justify-center', '') : structure
  const selectedStyles = recipeVariant === 'reaction' || recipeVariant === 'agent-option'
    ? selected ? selectedClass : unselectedClass
    : selected && recipeVariant === 'diff-line-action' ? selectedClass : ''
  const state = `${selectedStyles}  `
  const classes = `${aligned} ${''} ${chromeClass} ${state} ${noDrag ? '[-webkit-app-region:no-drag]' : ''} ${className}`

  return <ButtonFrame {...props} className={classes} />
}
