import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { HarnessFinding } from '../../houston/generated/HarnessFinding'
import type { AgentKind } from '../../houston/generated/AgentKind'
import { Button, Card, Inline, SectionHead, Text } from '../ui'

type Suggestions = { workspace: string; name: string; finding: HarnessFinding; agent: AgentKind }[]

export function TasksSuggested({ client, workspaces }: {
  client: HoustonClient | null
  workspaces: { path: string; name: string }[]
}): React.JSX.Element | null {
  const [suggestions, setSuggestions] = useState<Suggestions>([])
  useEffect(() => {
    setSuggestions([])
    if (!client || !workspaces.length) return
    const scope = new Map(workspaces.map((item) => [item.path, item.name]))
    const offState = client.subscribe('harness_state', (message) => {
      const name = scope.get(message.workspace)
      if (name === undefined) return
      const rows = message.findings.filter((finding) => finding.phase === 'open' && !finding.task)
        .map((finding) => ({ workspace: message.workspace, name, finding, agent: message.routine?.engine ?? 'claude' as AgentKind }))
      setSuggestions((current) => [...current.filter((item) => item.workspace !== message.workspace), ...rows])
    })
    const offChanged = client.subscribe('harness_changed', (message) => {
      if (scope.has(message.workspace)) client.harnessState(message.workspace)
    })
    workspaces.forEach((item) => client.harnessState(item.path))
    return () => { offState(); offChanged() }
  }, [client, workspaces])
  if (!suggestions.length) return null
  return (
    <Card shape="inset" data-testid="tasks-suggested">
      <SectionHead title="Suggested" count={suggestions.length} density="row" action={<Text size="small" tone="muted">from Review</Text>} />
      {suggestions.map(({ workspace, name, finding, agent }) => (
        <Card.Row key={`${workspace}:${finding.key}`} heading={finding.title}
          meta={`${name} · ${finding.count} ${finding.count === 1 ? 'session' : 'sessions'}`}
          action={<Inline gap="small">
            <Button variant="ghost" size="sm" onClick={() => client?.harnessDecide(workspace, finding.key, 'dismissed')}>Dismiss</Button>
            <Button variant="link" size="sm" onClick={() => client?.harnessFixTask(workspace, finding.key, agent, finding.apply_prompt)}>Add to queue</Button>
          </Inline>} />
      ))}
    </Card>
  )
}
