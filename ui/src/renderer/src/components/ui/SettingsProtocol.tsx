import type { ReactNode } from 'react'
import { Text } from './Text'

export function SettingsSectionBreak({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="pt-[var(--space-5)] pb-[var(--space-3)]">{children}</div>
}

export function ProtocolDescription({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" className="max-w-[var(--tr-width-protocol-description)]" size="base" leading="relaxed" tone="muted">{children}</Text>
}

export function SettingsActionRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-between gap-[var(--space-4)] py-[var(--tr-space-orchestration-action-block)] px-[var(--tr-space-orchestration-action-inline)] border-t border-t-[var(--divider)]">{children}</div>
}

export function SettingsProtocolSpecimen(): React.JSX.Element {
  return <div><SettingsSectionBreak><Text as="h3" size="subhead">Workspace routing</Text><ProtocolDescription>CLIs that speak the Agent Client Protocol can report status over that protocol.</ProtocolDescription></SettingsSectionBreak><SettingsActionRow><Text size="small" tone="muted">Matches what the daemon has stored.</Text><button type="button">Save</button></SettingsActionRow></div>
}
