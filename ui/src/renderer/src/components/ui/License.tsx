import type { HTMLAttributes, ReactNode } from 'react'

export function LicenseText({ children }: { children: ReactNode }): React.JSX.Element {
  return <pre className="m-0 max-h-[var(--tr-license-text-max-height)] overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] p-[var(--space-2)] font-mono [font-size:var(--tr-text-small-size)] leading-[var(--tr-text-ui-leading)] text-[var(--text-secondary)] whitespace-pre-wrap break-words">{children}</pre>
}

export function LicensePackage({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="border-t border-t-[var(--divider)] first:border-t-0 p-[var(--space-3)] flex flex-col gap-[var(--space-2)]">{children}</div>
}

export function LicenseList({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className="max-h-[var(--tr-license-list-max-height)] overflow-y-auto rounded-[var(--tr-radius-md)] border border-[var(--border)]">{children}</div>
}
