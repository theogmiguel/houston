import type { AgentKind } from '../../houston/generated/AgentKind'
import type { AgentAttention } from '../../useAgentAttention'
import { setSettingsSection } from '../../settingsNav'
import { Button, Card, PageHeader, Text } from '../ui'
import { engineLabel } from '../engineLabel'

export function AgentsOverview({ attention, onRepair, onCheck }: { attention: AgentAttention; onRepair: (provider: AgentKind, enabled: boolean) => void; onCheck: (name: string) => void }): React.JSX.Element {
  return <div className="grid gap-[var(--space-4)]" data-testid="agents-overview">
    <PageHeader heading="Agents" description="The CLIs Houston launches and what they run with: skills, MCP servers, and a weekly review of how the sessions went." />
    <section className="grid gap-[var(--space-2)]"><Text as="h2" size="ui" weight="semibold" flush>Needs you</Text><Card shape="card">
      {attention.issues.length ? attention.issues.map((issue) => <Card.Row key={issue.key} heading={issue.provider ? `${engineLabel(issue.provider)} hooks need repair` : issue.title} meta={issue.detail} action={<Button variant="secondary" onClick={() => {
        if (issue.action === 'repair-hooks' && issue.provider) onRepair(issue.provider, true)
        else if (issue.action === 'check-again' && issue.server) onCheck(issue.server)
        else setSettingsSection(issue.section)
      }}>{issue.action === 'repair-hooks' ? 'Repair hooks' : issue.action === 'check-again' ? 'Check again' : issue.section === 'agents-review' ? 'Open Review' : 'Open Skills'}</Button>} />) : <Card.Row heading={attention.known.clis && attention.known.skills && attention.known.mcp ? 'Nothing needs you' : 'Checking agent setup…'} meta="Status comes from the last reported check." />}
    </Card></section>
    <section className="grid gap-[var(--space-2)]"><Text as="h2" size="ui" weight="semibold" flush>Status</Text><Card shape="card">
      {(['agents-clis', 'agents-skills', 'agents-mcp', 'agents-review'] as const).map((section) => <Card.Row key={section} heading={{ 'agents-clis': 'CLIs', 'agents-skills': 'Skills', 'agents-mcp': 'MCP servers', 'agents-review': 'Review' }[section]} meta={section === 'agents-review' ? 'The schedule lives in Routines.' : 'Configuration and the latest reported state.'} status={<Text size="small" tone={attention.counts[section] ? 'warn' : 'muted'}>{attention.counts[section] ? `${attention.counts[section]} need you` : section === 'agents-review' || attention.known[section === 'agents-clis' ? 'clis' : section === 'agents-skills' ? 'skills' : 'mcp'] ? 'No reported problems' : 'Not checked yet'}</Text>} action={<Button variant="ghost" onClick={() => setSettingsSection(section)}>Open {section === 'agents-clis' ? 'CLIs' : section === 'agents-skills' ? 'Skills' : section === 'agents-mcp' ? 'MCP servers' : 'Review'}</Button>} />)}
    </Card></section>
  </div>
}
