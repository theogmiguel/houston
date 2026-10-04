import type { HTMLAttributes, ReactNode } from 'react'
import { PAGE_COLUMN_CLS, PAGE_COLUMN_WIDE_CLS } from '../settingsPrimitives'
import { variants } from './variants'

export type PageWidth = 'form' | 'wide'

const frameClasses = variants(
  'grid min-h-0 w-full content-start gap-[var(--space-3)] overflow-y-auto px-[var(--space-4-5)] pt-[var(--space-4)] pb-[var(--space-4-5)]',
  { width: { form: PAGE_COLUMN_CLS, wide: PAGE_COLUMN_WIDE_CLS } },
  { width: 'form' }
)

export interface PageFrameProps extends Omit<HTMLAttributes<HTMLElement>, 'className'> {
  width?: PageWidth
  children: ReactNode
  className?: string
}

export function PageFrame({ width = 'form', children, className = '', ...props }: PageFrameProps): React.JSX.Element {
  return (
    <main {...props} className={`${frameClasses({ width })} mx-auto ${className}`}>
      {children}
    </main>
  )
}
