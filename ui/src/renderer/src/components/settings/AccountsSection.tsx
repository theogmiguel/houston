import { AgentProfiles } from '../AgentProfiles'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { AgentProfileState } from '../SettingsView'

export interface AccountsSectionProps {
  agentProfiles: AgentProfileState | null
  onAgentProfileUpsert: (id: number | null, agent: AgentKind, name: string, configDir: string) => void
  onAgentProfileDelete: (id: number) => void
  onAgentProfileSetActive: (agent: AgentKind, id: number | null) => void
}

export function AccountsSection({
  agentProfiles,
  onAgentProfileUpsert,
  onAgentProfileDelete,
  onAgentProfileSetActive
}: AccountsSectionProps): React.JSX.Element {
  return (
    <>
      <AgentProfiles
        profiles={agentProfiles?.profiles ?? []}
        active={agentProfiles?.active ?? []}
        onUpsert={onAgentProfileUpsert}
        onDelete={onAgentProfileDelete}
        onSetActive={onAgentProfileSetActive}
      />
    </>
  )
}
