import type { HTMLAttributes, ReactNode } from 'react'
import { PAGE_COLUMN_CLS, PAGE_COLUMN_WIDE_CLS } from './settingsPrimitives'
import { variants } from './variants'

export type PageWidth = 'form' | 'wide' | 'settings' | 'settingsWide'

const frameClasses = variants(
  'grid w-full content-start',
  {
    width: {
      form: PAGE_COLUMN_CLS,
      wide: PAGE_COLUMN_WIDE_CLS,
      settings: 'max-w-[896px]',
      settingsWide: 'max-w-[1024px]'
    },
    scroll: { true: 'overflow-y-auto', false: '' },
    padding: {
      default: 'min-h-0 gap-[var(--space-3)] px-[var(--space-4-5)] pt-[var(--space-4)] pb-[var(--space-4-5)]',
      settings: 'min-h-full gap-0 px-[var(--space-6)] pt-[var(--space-4)] pb-[var(--space-6)]'
    }
  },
  { width: 'form', scroll: 'true', padding: 'default' }
)

export interface PageFrameProps extends Omit<HTMLAttributes<HTMLElement>, 'className'> {
  width?: PageWidth
  scroll?: boolean
  padding?: 'default' | 'settings'
  children: ReactNode
  className?: string
}

export function PageFrame({
  width = 'form',
  scroll = true,
  padding = 'default',
  children,
  className = '',
  ...props
}: PageFrameProps): React.JSX.Element {
  return (
    <main
      {...props}
      className={`${frameClasses({ width, scroll: String(scroll) as 'true' | 'false', padding })} mx-auto ${className}`}
    >
      {children}
    </main>
  )
}
