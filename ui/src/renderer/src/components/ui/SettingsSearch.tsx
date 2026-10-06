import type { ChangeEventHandler, InputHTMLAttributes, Ref } from 'react'
import { IconSearch } from '../icons'

export function SettingsSearch({
  inputRef,
  value,
  onChange,
  onKeyDown
}: {
  inputRef: Ref<HTMLInputElement>
  value: string
  onChange: ChangeEventHandler<HTMLInputElement>
  onKeyDown: InputHTMLAttributes<HTMLInputElement>['onKeyDown']
}): React.JSX.Element {
  return (
    <label className="flex h-8 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-transparent px-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] focus-within:border-[var(--accent)] focus-within:bg-hover-fill">
      <IconSearch className="h-[14px] w-[14px] flex-none text-[var(--text-faint)]" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Search"
        aria-label="Search settings"
        className="min-w-0 flex-1 bg-transparent text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus-visible:outline focus-visible:outline-[var(--accent)]"
      />
      <kbd className="ml-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] px-[var(--space-1)] text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">/</kbd>
    </label>
  )
}
