import type { ButtonHTMLAttributes, InputHTMLAttributes } from 'react'

export function RenameActionButton(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...props}
      className={`btn bg-transparent border-0 py-0 px-[var(--space-0-5)] text-[color-mix(in_srgb,var(--accent)_55%,var(--text-muted))] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer inline-flex items-center flex-none [transition:opacity_0.12s_var(--animate-ease-menu,ease)] hover:text-text-primary ${props.className ?? ''}`.trim()}
    />
  )
}

export function RenameTitleInput(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      {...props}
      className="[font:inherit] font-semibold bg-background border border-primary rounded-[var(--tr-radius-input)] text-text-primary px-[var(--space-1)] py-0 min-w-0 w-[var(--w-rename-title-input)]"
    />
  )
}
