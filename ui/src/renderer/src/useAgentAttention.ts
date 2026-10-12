import { useMemo } from 'react'
import type { AgentHookState } from './houston/generated/AgentHookState'
import type { AgentKind } from './houston/generated/AgentKind'
import type { HarnessAttention } from './houston/generated/HarnessAttention'
import type { McpConnectionCheck } from './houston/generated/McpConnectionCheck'
import type { SkillToolState } from './houston/generated/SkillToolState'
import { buildSkillRows } from './houston/skillRows'

export type AgentSetupSection = 'agents-clis' | 'agents-skills' | 'agents-mcp' | 'agents-review'
export interface AgentAttentionIssue {
  key: string
  section: AgentSetupSection
  title: string
  detail: string
  action: 'open' | 'repair-hooks' | 'check-again'
  provider?: AgentKind
  server?: string
  workspace?: string
}
export interface AgentAttentionInput {
  agentHooks: readonly AgentHookState[] | null
  skills: SkillToolState[] | null
  checks: readonly [string, McpConnectionCheck][] | null
  reviews: readonly HarnessAttention[]
}
export interface AgentAttention {
  total: number
  counts: Record<AgentSetupSection, number>
  issues: AgentAttentionIssue[]
  sources: { installedClis: number; skillCount: number; serverCount: number }
  known: { clis: boolean; skills: boolean; mcp: boolean }
}

export function agentAttentionFor({ agentHooks, skills, checks, reviews }: AgentAttentionInput): AgentAttention {
  const issues: AgentAttentionIssue[] = []
  const providers = new Set<AgentKind>()
  for (const hook of agentHooks ?? []) {
    if (!hook.present || !(hook.error || (hook.enabled && !hook.installed)) || providers.has(hook.provider)) continue
    providers.add(hook.provider)
    issues.push({ key: `cli:${hook.provider}`, section: 'agents-clis', title: `${hook.provider} hooks need repair`, detail: hook.error ?? `Houston hooks are not installed at ${hook.path}`, action: 'repair-hooks', provider: hook.provider })
  }
  for (const row of buildSkillRows(skills ?? [])) {
    if (!row.hasDrift) continue
    issues.push({ key: `skill:${row.name}`, section: 'agents-skills', title: row.claude && row.byTool.codex && row.byTool.codex.digest !== row.claude.digest ? `Codex copy differs for ${row.name}` : `${row.name} copies differ`, detail: 'Agent copies have different content digests.', action: 'open' })
  }
  for (const tool of skills ?? []) {
    if (tool.error) issues.push({ key: `skill-tool:${tool.tool}`, section: 'agents-skills', title: `${tool.tool} skills could not be read`, detail: tool.error, action: 'open' })
  }
  const servers = new Set<string>()
  for (const [name, check] of checks ?? []) {
    if (check.state !== 'failed' || servers.has(name)) continue
    servers.add(name)
    issues.push({ key: `mcp:${name}`, section: 'agents-mcp', title: `Houston can't start ${name}`, detail: check.message, action: 'check-again', server: name })
  }
  const counts: AgentAttention['counts'] = { 'agents-clis': 0, 'agents-skills': 0, 'agents-mcp': 0, 'agents-review': 0 }
  for (const issue of issues) counts[issue.section]++
  for (const review of reviews) {
    if (review.attention <= 0) continue
    counts['agents-review'] += review.attention
    issues.push({ key: `review:${review.workspace}`, section: 'agents-review', title: `${review.attention} review ${review.attention === 1 ? 'finding needs' : 'findings need'} you`, detail: review.workspace, action: 'open', workspace: review.workspace })
  }
  return { sources: { installedClis: new Set((agentHooks ?? []).filter((hook) => hook.present).map((hook) => hook.provider)).size, skillCount: buildSkillRows(skills ?? []).length, serverCount: new Set((checks ?? []).map(([name]) => name)).size }, total: Object.values(counts).reduce((sum, count) => sum + count, 0), counts, issues, known: { clis: agentHooks !== null, skills: skills !== null, mcp: checks !== null } }
}

export function useAgentAttention(input: AgentAttentionInput): AgentAttention {
  return useMemo(() => agentAttentionFor(input), [input.agentHooks, input.skills, input.checks, input.reviews])
}
