import type { AgentKind } from '../../houston/generated/AgentKind'
import type { HoustonClient } from '../../houston/client'
import type { HarnessState } from '../../houston/useHarness'
import type { AgentAttention, AgentAttentionIssue, AgentSetupSection } from '../../useAgentAttention'
import { setSettingsSection } from '../../settingsNav'
import { Button, Card, PageHeader, Text } from '../ui'
import { AgentSetupRow, type SetupTone } from '../ui/AgentSetupRow'
import { engineLabel } from '../engineLabel'
import { scheduleLabel } from '../nav/harnessFormat'
import { useOverviewReviews } from './useOverviewReviews'

const LABEL: Record<AgentSetupSection, string> = { 'agents-clis': 'CLIs', 'agents-skills': 'Skills', 'agents-mcp': 'MCP servers', 'agents-review': 'Review' }
function issueHeading(issue: AgentAttentionIssue): string {
  return issue.provider ? `${issue.provider === 'opencode' ? 'OpenCode' : engineLabel(issue.provider)} stopped reporting status` : issue.title
}
function summary(attention: AgentAttention, section: AgentSetupSection, reviews: HarnessState[]): string {
  const problem = attention.issues.find((issue) => issue.section === section)
  if (section === 'agents-clis') return !attention.known.clis ? 'Not checked yet' : `${attention.sources.installedClis} installed${problem ? ` · ${issueHeading(problem)}` : ' · Hooks checked'}`
  if (section === 'agents-skills') return !attention.known.skills ? 'Not checked yet' : `${attention.sources.skillCount} skills${problem ? ` · ${problem.title}` : ' · Copies match'}`
  if (section === 'agents-mcp') return !attention.known.mcp ? 'Not checked yet' : `${attention.sources.serverCount} server${attention.sources.serverCount === 1 ? '' : 's'}${problem ? ` · ${problem.server} can't start` : ' · No reported failures'}`
  const state = reviews.find((item) => item.routine) ?? reviews[0]
  return state?.routine ? `${scheduleLabel(state.routine)} · ${attention.counts['agents-review']} new finding${attention.counts['agents-review'] === 1 ? '' : 's'}` : state?.reviews.length ? `${attention.counts['agents-review']} new finding${attention.counts['agents-review'] === 1 ? '' : 's'} · No review schedule` : 'Set up a weekly review in Routines.'
}
function status(attention: AgentAttention, section: AgentSetupSection): { tone: SetupTone; label: string } {
  const count = attention.counts[section]
  if (count) return { tone: section === 'agents-mcp' ? 'danger' : 'warn', label: { 'agents-clis': `${count} to repair`, 'agents-skills': `${count} out of sync`, 'agents-mcp': `${count} failing`, 'agents-review': `${count} new finding${count === 1 ? '' : 's'}` }[section] }
  const known = section === 'agents-review' || attention.known[section === 'agents-clis' ? 'clis' : section === 'agents-skills' ? 'skills' : 'mcp']
  return { tone: known ? 'ok' : 'muted', label: known ? 'No reported problems' : 'Not checked yet' }
}
function ReviewRows({ attention, reviews }: { attention: AgentAttention; reviews: HarnessState[] }): React.JSX.Element | null {
  const rows = reviews.flatMap((state) => state.findings.filter((finding) => finding.phase === 'open').map((finding) => ({ state, finding })))
  // Keep Overview short; the owning Review page exposes every finding.
  const visible = rows.slice(0, 6)
  const remaining = Math.max(0, attention.counts['agents-review'] - visible.length)
  if (!visible.length && !remaining) return null
  return <>{visible.map(({ state, finding }) => {
    const sessions = state.reviews.find((review) => review.id === finding.review_id)?.sessions
    const detail = sessions == null ? `${finding.count} sessions · Review` : `${finding.count} of ${sessions} sessions · Review`
    return <AgentSetupRow key={`${state.workspace}:${finding.key}`} heading={finding.title} detail={detail} tone="warn" action={<Button variant="secondary" onClick={() => setSettingsSection('agents-review')}>Open {LABEL['agents-review']}</Button>} />
  })}{remaining > 0 && <AgentSetupRow heading={rows.length ? `+${remaining} more` : 'Reading review findings…'} detail="Review" tone="warn" action={<Button variant="ghost" onClick={() => setSettingsSection('agents-review')}>Open {LABEL['agents-review']}</Button>} />}</>
}
export function AgentsOverview({ attention, onRepair, onCheck, client = null, workspace, reviewStates }: { attention: AgentAttention; onRepair: (provider: AgentKind, enabled: boolean) => void; onCheck: (name: string) => void; client?: HoustonClient | null; workspace?: string | null; reviewStates?: HarnessState[] }): React.JSX.Element {
  const reported = useOverviewReviews(client, attention, workspace)
  const reviews = reviewStates ?? reported
  return <div className="grid gap-[var(--space-6)]" data-testid="agents-overview">
    <PageHeader heading="Agents" description="The CLIs Houston launches and what they run with: skills, MCP servers, and a weekly review of how the sessions went." />
    <section className="grid gap-[var(--space-3)]"><Text as="h2" size="ui" weight="semibold" flush>Needs you</Text><Card shape="card">
      {attention.issues.filter((issue) => issue.section !== 'agents-review').sort((a, b) => Number(b.section === 'agents-mcp') - Number(a.section === 'agents-mcp')).map((issue) => <AgentSetupRow key={issue.key} heading={issueHeading(issue)} detail={`${issue.detail} · ${LABEL[issue.section]}`} tone={issue.section === 'agents-mcp' ? 'danger' : 'warn'} action={<Button variant="secondary" onClick={() => {
        if (issue.action === 'repair-hooks' && issue.provider) onRepair(issue.provider, true)
        else if (issue.action === 'check-again' && issue.server) onCheck(issue.server)
        else setSettingsSection(issue.section)
      }}>{issue.action === 'repair-hooks' ? 'Repair hooks' : issue.action === 'check-again' ? 'Check again' : 'Open Skills'}</Button>} />)}
      <ReviewRows attention={attention} reviews={reviews} />
      {!attention.total && <Card.Row heading={attention.known.clis && attention.known.skills && attention.known.mcp ? 'Nothing needs you' : 'Checking agent setup…'} meta="Status comes from the last reported check." />}
    </Card></section>
    <section className="grid gap-[var(--space-3)]"><Text as="h2" size="ui" weight="semibold" flush>Status</Text><Card shape="card">
      {(Object.keys(LABEL) as AgentSetupSection[]).map((section) => { const value = status(attention, section); return <AgentSetupRow key={section} heading={LABEL[section]} detail={summary(attention, section, reviews)} tone={value.tone} status={value.label} onClick={() => setSettingsSection(section)} /> })}
    </Card></section>
  </div>
}
