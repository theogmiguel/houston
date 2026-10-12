import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { HarnessState } from '../../houston/useHarness'
import type { AgentAttention } from '../../useAgentAttention'

// Bound config reads when many workspaces need attention; the Review page handles the rest.
const WORKSPACE_LIMIT = 8
export function useOverviewReviews(client: HoustonClient | null, attention: AgentAttention, workspace?: string | null): HarnessState[] {
  const key = JSON.stringify([...new Set([workspace, ...attention.issues.filter((issue) => issue.workspace).map((issue) => issue.workspace)].filter((path): path is string => Boolean(path)))].slice(0, WORKSPACE_LIMIT))
  const [states, setStates] = useState<HarnessState[]>([])
  useEffect(() => {
    setStates([])
    if (!client) return
    const paths = JSON.parse(key) as string[]
    const off = client.subscribe('harness_state', (msg) => {
      if (!paths.includes(msg.workspace)) return
      const state: HarnessState = { workspace: msg.workspace, routine: msg.routine ?? null, reviews: msg.reviews, findings: msg.findings, models: msg.models, providerCoverage: msg.provider_coverage, engineRefusals: msg.engine_refusals ?? [] }
      setStates((previous) => [...previous.filter((item) => item.workspace !== state.workspace), state])
    })
    const offChanged = client.subscribe('harness_changed', (msg) => { if (paths.includes(msg.workspace)) client.harnessState(msg.workspace) })
    paths.forEach((path) => client.harnessState(path))
    return () => { off(); offChanged() }
  }, [client, key])
  return states
}
