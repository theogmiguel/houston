import { useEffect } from 'react'
import type { HoustonClient } from './houston/client'
import type { SettingsSectionId } from './settingsSections'

export function useAgentSettingsReads(client: HoustonClient | null, open: boolean, section: SettingsSectionId): void {
  useEffect(() => {
    if (!client || !open) return
    if (section === 'agents-overview' || section === 'agents-clis') client.agentHooks()
    if (section === 'agents-overview' || section === 'agents-mcp') client.mcpState()
    if (section === 'agents-overview' || section === 'agents-skills') client.skillSync()
  }, [client, open, section])
}
