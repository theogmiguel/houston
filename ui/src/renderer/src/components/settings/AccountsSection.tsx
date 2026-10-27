import { AgentProfiles } from '../AgentProfiles'
import type { HoustonClient } from '../../houston/client'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { AgentProfileState } from '../SettingsView'
import { BitbucketAccount } from './BitbucketAccount'

export interface AccountsSectionProps {
  client?: HoustonClient | null
  agentProfiles: AgentProfileState | null
  onAgentProfileUpsert: (id: number | null, agent: AgentKind, name: string, configDir: string) => void
  onAgentProfileDelete: (id: number) => void
  onAgentProfileSetActive: (agent: AgentKind, id: number | null) => void
}

export function AccountsSection({
  client = null,
  agentProfiles,
  onAgentProfileUpsert,
  onAgentProfileDelete,
  onAgentProfileSetActive
}: AccountsSectionProps): React.JSX.Element {
  return <>
    <AgentProfiles
      profiles={agentProfiles?.profiles ?? []}
      active={agentProfiles?.active ?? []}
      onUpsert={onAgentProfileUpsert}
      onDelete={onAgentProfileDelete}
      onSetActive={onAgentProfileSetActive}
    />
    <BitbucketAccount client={client} />
  </>
}
