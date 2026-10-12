import { openSettings } from '../../settingsNav'

function Ancestor({ children }: { children: string }): React.JSX.Element {
  return <a href="#settings/agents-overview" className="underline underline-offset-2 hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-[var(--border-focus)]" onClick={(event) => { event.preventDefault(); openSettings('agents-overview') }}>{children}</a>
}

export function SettingsBreadcrumb({ open, section }: { open: boolean; section: string }): React.JSX.Element {
  const parts = section.split(' / ')
  return <span hidden={!open} className="min-w-0 truncate text-[length:var(--tr-text-ui-size)] text-[var(--text-secondary)] [-webkit-app-region:no-drag]">
    <Ancestor>Settings</Ancestor><span className="px-[var(--space-1)] text-[var(--text-faint)]">/</span>
    {parts.length > 1 && <><Ancestor>{parts[0]}</Ancestor><span className="px-[var(--space-1)] text-[var(--text-faint)]">/</span></>}
    <strong className="font-medium text-[var(--text-primary)]">{parts[parts.length - 1]}</strong>
  </span>
}
