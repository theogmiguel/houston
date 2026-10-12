import { useEffect, type ComponentProps } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { McpStateView } from '../SettingsView'
import type { SettingsSectionId } from '../../settingsSections'
import { showItemInFolder } from '../../houston/bridge'
import { setRailView } from '../../railView'
import { setSettingsOpen } from '../../settingsNav'
import { SkillsSurface } from '../nav/SkillsSurface'
import { McpSurface } from '../nav/McpSurface'
import { HarnessView } from '../nav/HarnessView'

type SkillsInput = Pick<ComponentProps<typeof SkillsSurface>, 'workspace' | 'focusedPaneName' | 'focusedPaneAgent' | 'runBlockedReason' | 'onRunSkill' | 'tools' | 'pushes' | 'autoPushEnabled' | 'checkedAt'>
type ReviewInput = Omit<ComponentProps<typeof HarnessView>, 'embedded' | 'onOpenRoutines'>

export function useAgentSettingsReads(client: HoustonClient | null, open: boolean, section: SettingsSectionId): void {
  useEffect(() => {
    if (!client || !open) return
    if (section === 'agents-overview' || section === 'agents-clis') client.agentHooks()
    if (section === 'agents-overview' || section === 'agents-mcp') client.mcpState()
    if (section === 'agents-overview' || section === 'agents-skills') client.skillSync()
  }, [client, open, section])
}

export function agentSettingsPages({ client, skills, mcp, mcpCheckedAt, review }: { client: HoustonClient | null; skills: SkillsInput; mcp: McpStateView | null; mcpCheckedAt: number | null; review: ReviewInput }) {
  return {
    'agents-skills': <SkillsSurface {...skills} embedded client={client} onRefresh={() => client?.skillSync()} onPush={(tool, skill) => client?.skillPush(tool, skill)} onPushUndo={(tool, skill) => client?.skillPushUndo(tool, skill)} onAutoPushSet={(enabled) => client?.skillAutoPushSet(enabled)} />,
    'agents-mcp': <McpSurface embedded source={mcp?.source ?? []} tools={mcp?.tools ?? []} results={mcp?.results ?? []} checks={mcp?.checks ?? []} loaded={mcp !== null} sourcePath={mcp?.sourcePath ?? null} checkedAt={mcpCheckedAt} onRefresh={() => client?.mcpState()} onSync={(tool) => client?.mcpSync(tool)} onImport={(tool) => client?.mcpImport(tool)} onSetEnabled={(name, enabled) => client?.mcpSetEnabled(name, enabled)} onUpsertServer={(name, server) => client?.mcpServerUpsert(name, server)} onRemoveServer={(name) => client?.mcpServerRemove(name)} onTest={(name) => client?.mcpTest(name)} onOpenSource={() => { if (mcp) void showItemInFolder(mcp.sourcePath) }} />,
    'agents-review': <HarnessView {...review} embedded onOpenRoutines={() => { setSettingsOpen(false); setRailView('routines') }} />
  }
}
