export function SettingsBreadcrumb({
  open,
  section
}: {
  open: boolean
  section: string
}): React.JSX.Element {
  return (
    <span
      hidden={!open}
      className="min-w-0 truncate text-[length:var(--tr-text-ui-size)] text-[var(--text-secondary)] [-webkit-app-region:no-drag]"
    >
      Settings <span className="px-1 text-[var(--text-faint)]">/</span>
      <strong className="font-medium text-[var(--text-primary)]">{section}</strong>
    </span>
  )
}
