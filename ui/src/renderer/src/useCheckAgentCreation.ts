import { useCallback } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AgentKind, HoustonClient, SessionInfo } from './houston/client'
import type { CheckAgentTarget } from './components/prs/ChecksList'
import type { PaneKey } from './layout/tree'

export interface CheckAgentSplitIntent {
  anchor: number
  side: 'left' | 'right' | 'top' | 'bottom'
  ws: string
  projectDir: string
  agent: AgentKind
  ts: number
}

interface UseCheckAgentCreationOptions {
  client: HoustonClient | null
  selectedWorkspace: string
  panelWorkspace: string
  targets: CheckAgentTarget[]
  activeIdRef: { current: number | null }
  sessionsRef: { current: ReadonlyMap<number, SessionInfo> }
  shellIntegration: boolean
  setSelectedWorkspace: Dispatch<SetStateAction<string>>
  setExpandedId: Dispatch<SetStateAction<PaneKey | null>>
  splitIntents: MutableRefObject<CheckAgentSplitIntent[]>
}

export function useCheckAgentCreation({
  client,
  selectedWorkspace,
  panelWorkspace,
  targets,
  activeIdRef,
  sessionsRef,
  shellIntegration,
  setSelectedWorkspace,
  setExpandedId,
  splitIntents,
}: UseCheckAgentCreationOptions): (provider: string, text: string) => Promise<number | null> {
  return useCallback((provider, text) => {
    const agents: Record<string, AgentKind> = {
      Claude: 'claude', Codex: 'codex', Antigravity: 'antigravity',
      OpenCode: 'opencode', Cursor: 'cursor', Grok: 'grok', ZCode: 'zcode'
    }
    const agent = agents[provider]
    const workspace = selectedWorkspace === 'all' ? panelWorkspace : selectedWorkspace
    if (!client || !agent || workspace === 'all') return Promise.resolve(null)
    const focused = activeIdRef.current
    const anchor = targets.some((target) => target.session === focused) ? focused : targets[0]?.session ?? null
    if (selectedWorkspace !== workspace) setSelectedWorkspace(workspace)
    setExpandedId(null)
    if (anchor !== null) {
      splitIntents.current.push({ anchor, side: 'right', ws: workspace, projectDir: workspace, agent, ts: Date.now() })
    }
    const existingSessions = new Set(sessionsRef.current.keys())
    const createdSession = new Promise<number | null>((resolve) => {
      let unsubscribe = (): void => {}
      const timeout = window.setTimeout(() => {
        unsubscribe()
        resolve(null)
      }, 30_000)
      unsubscribe = client.subscribe('session_created', (message) => {
        if (existingSessions.has(message.info.id) || message.info.agent !== agent || message.info.project_dir !== workspace) return
        window.clearTimeout(timeout)
        unsubscribe()
        resolve(message.info.id)
      })
    })
    client.createSession({ agent, project_dir: workspace, cwd_from: anchor ?? undefined, shell_integration: shellIntegration, prompt: text })
    return createdSession
  }, [activeIdRef, client, panelWorkspace, selectedWorkspace, sessionsRef, setExpandedId, setSelectedWorkspace, shellIntegration, splitIntents, targets])
}
