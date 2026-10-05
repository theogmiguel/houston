import { AgentProfiles } from '../AgentProfiles'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { AgentProfileState } from '../SettingsView'
import type { HoustonClient } from '../../houston/client'
import { SlackAccount } from './SlackAccount'
import { SectionHead } from './shared'

export interface AccountsSectionProps {
  client: HoustonClient | null
  agentProfiles: AgentProfileState | null
  onAgentProfileUpsert: (id: number | null, agent: AgentKind, name: string, configDir: string) => void
  onAgentProfileDelete: (id: number) => void
  onAgentProfileSetActive: (agent: AgentKind, id: number | null) => void
}

export function AccountsSection({
  client,
  agentProfiles,
  onAgentProfileUpsert,
  onAgentProfileDelete,
  onAgentProfileSetActive
}: AccountsSectionProps): React.JSX.Element {
  return (
    <>
      <SectionHead
        title="Accounts"
        lede="Named CLAUDE_CONFIG_DIR / CODEX_HOME overrides: pick what new panes run as. Each profile is a separate config directory, so two profiles are two logins that never see each other. A pane keeps the profile it launched with."
      />
      <AgentProfiles
        profiles={agentProfiles?.profiles ?? []}
        active={agentProfiles?.active ?? []}
        onUpsert={onAgentProfileUpsert}
        onDelete={onAgentProfileDelete}
        onSetActive={onAgentProfileSetActive}
      />
      <SlackAccount client={client} />
    </>
  )
}
