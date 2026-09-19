import type { AgentKind } from '../../houston/generated/AgentKind'
import type { McpConnectionCheck } from '../../houston/generated/McpConnectionCheck'
import type { McpServer } from '../../houston/generated/McpServer'
import type { McpSyncResult } from '../../houston/generated/McpSyncResult'
import type { McpToolState } from '../../houston/generated/McpToolState'
import { lazy, Suspense } from 'react'
import { NavColumn } from './navChrome'
import { MATERIAL_CLS, materialAttrs } from '../material'

const McpManager = lazy(() =>
  import('../McpManager').then((m) => ({ default: m.McpManager }))
)

export function McpSurface(props: {
  source: McpServer[]
  tools: McpToolState[]
  results: McpSyncResult[]
  checks: Array<[string, McpConnectionCheck]>
  loaded: boolean
  onRefresh: () => void
  onSync: (tool: AgentKind | null) => void
  onImport: (tool: AgentKind) => void
  onSetEnabled: (name: string, enabled: boolean) => void
  onUpsertServer: (previousName: string | null, server: McpServer) => void
  onRemoveServer: (name: string) => void
  onTest: (name: string) => void
  onOpenSource: () => void
  sourcePath?: string | null
  checkedAt?: number | null
}): React.JSX.Element {
  const {
    source,
    tools,
    results,
    checks,
    loaded,
    onRefresh,
    onSync,
    onImport,
    onSetEnabled,
    onUpsertServer,
    onRemoveServer,
    onTest,
    onOpenSource,
    sourcePath,
    checkedAt = null
  } = props
  return (
    <div
      data-testid="nav-surface"
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full min-h-0 overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      <NavColumn wide>
        <Suspense fallback={<div className="[font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">Loading…</div>}>
          <McpManager
            source={source}
            tools={tools}
            results={results}
            checks={checks}
            loaded={loaded}
            onRefresh={onRefresh}
            onSync={onSync}
            onImport={onImport}
            onSetEnabled={onSetEnabled}
            onUpsertServer={onUpsertServer}
            onRemoveServer={onRemoveServer}
            onTest={onTest}
            onOpenSource={onOpenSource}
            sourcePath={sourcePath}
            checkedAt={checkedAt}
          />
        </Suspense>
      </NavColumn>
    </div>
  )
}
