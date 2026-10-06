import type { HTMLAttributes, ReactNode } from 'react'

export function DevBadge({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }): React.JSX.Element {
  return <span {...props} className="px-[var(--tr-dev-badge-inset-x)] py-[var(--tr-badge-inset-y)] font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] rounded-[var(--tr-radius-input)] bg-[color-mix(in_srgb,var(--warn)_18%,transparent)] text-[var(--warn)]">{children}</span>
}
