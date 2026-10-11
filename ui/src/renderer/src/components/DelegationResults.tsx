import { useEffect, useRef, useState } from 'react'
import type { HoustonClient } from '../houston/client'
import type { DelegationResult } from '../houston/generated/DelegationResult'
import type { InboxRow } from '../houston/generated/InboxRow'
import { showItemInFolder } from '../houston/bridge'
import { Button, Notice } from './ui'
import { Text } from './ui/Text'
import { OrchestrationBody, OrchestrationReason } from './ui/OrchestrationContent'
import { OrchestratorActionRow, OrchestratorChildCard, OrchestratorChildHeader, OrchestratorChildTitle, OrchestratorMetadata, OrchestratorSectionLabel } from './ui/OrchestratorOverview'

interface ResultReadState {
  detail: InboxRow | null
  expanded: number | null
  copied: number | null
  pending: number | null
  error: { id: number; message: string } | null
  read: (id: number, copying: boolean) => void
  reveal: (id: number, path: string) => Promise<void>
}

function useResultRead(parentId: number, client: HoustonClient): ResultReadState {
  const [detail, setDetail] = useState<InboxRow | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState<{ id: number; message: string } | null>(null)
  const request = useRef<{ id: number; copy: boolean } | null>(null)
  const generation = useRef(0)
  const scope = useRef(parentId)
  scope.current = parentId
  const copy = async (row: InboxRow): Promise<void> => {
    const started = generation.current
    const parent = parentId
    setPending(Number(row.id))
    try {
      await navigator.clipboard.writeText(row.body)
      if (scope.current === parent && generation.current === started) setCopied(Number(row.id))
    } catch (failure) {
      if (scope.current === parent && generation.current === started) setError({ id: Number(row.id), message: `Could not copy result: ${String(failure)}` })
    } finally {
      if (scope.current === parent && generation.current === started) setPending(null)
    }
  }
  useEffect(() => {
    generation.current += 1
    request.current = null
    setPending(null)
    setCopied(null)
    setDetail(null)
    setExpanded(null)
    setError(null)
    const offDetail = client.subscribe('delegation_result_detail', (message) => {
      if (scope.current !== parentId || message.parent !== parentId || Number(message.row.id) !== request.current?.id) return
      const action = request.current
      request.current = null
      setPending(null)
      setDetail(message.row)
      if (action.copy) void copy(message.row)
      else setExpanded(Number(message.row.id))
    })
    const offRefused = client.subscribe('delegation_result_refused', (message) => {
      if (scope.current !== parentId || message.parent !== parentId || message.message_id !== request.current?.id) return
      request.current = null
      setPending(null)
      setError({ id: message.message_id, message: message.message })
    })
    return () => { generation.current += 1; request.current = null; offDetail(); offRefused() }
  }, [client, parentId])
  useEffect(() => {
    if (pending == null) return
    const timer = window.setTimeout(() => {
      generation.current += 1
      request.current = null
      setPending(null)
      setError({ id: pending, message: 'Result action did not complete. Try again when connected.' })
    }, 10_000)
    return () => window.clearTimeout(timer)
  }, [pending])
  const read = (id: number, copying: boolean): void => {
    generation.current += 1
    setError(null)
    setCopied(null)
    if (detail && Number(detail.id) === id) {
      if (copying) void copy(detail)
      else setExpanded((current) => current === id ? null : id)
      return
    }
    request.current = { id, copy: copying }
    setPending(id)
    client.delegationResultGet(parentId, id)
  }
  const reveal = async (id: number, path: string): Promise<void> => {
    const started = generation.current
    try {
      const outcome = await showItemInFolder(path)
      if (scope.current !== parentId || generation.current !== started) return
      if (!outcome.ok) setError({ id, message: outcome.error ?? `Could not reveal ${path}` })
    } catch (failure) {
      if (scope.current === parentId && generation.current === started) setError({ id, message: `Could not reveal ${path}: ${String(failure)}` })
    }
  }
  return { detail, expanded, copied, pending, error, read, reveal }
}

function ExpandedResult({ resultId, state }: { resultId: number; state: ResultReadState }): React.JSX.Element | null {
  const detail = state.detail
  if (state.expanded !== resultId || !detail || Number(detail.id) !== resultId) return null
  return <>
    <OrchestrationBody>{detail.body}</OrchestrationBody>
    {detail.artifacts.length > 0 && <div className="grid gap-[var(--space-1)]"><Text weight="semibold" size="small">Artifacts</Text>{detail.artifacts.map((path) => <Button key={path} size="sm" variant="ghost" onClick={() => void state.reveal(resultId, path)}>{path}</Button>)}</div>}
  </>
}

function ResultCard({ result, state }: { result: DelegationResult; state: ResultReadState }): React.JSX.Element {
  return <OrchestratorChildCard>
      <OrchestratorChildHeader><OrchestratorChildTitle>{result.role ?? result.from_codename ?? `Child ${result.child}`}</OrchestratorChildTitle></OrchestratorChildHeader>
      <OrchestratorMetadata><span>pane {result.child}</span>{result.request_id != null && <span>request {result.request_id}</span>}<time dateTime={new Date(result.created_at).toISOString()}>{new Date(result.created_at).toLocaleString()}</time></OrchestratorMetadata>
      <Text size="small" tone="muted">{result.provisional ? 'Provisional result' : result.ready_at == null ? 'Result staged' : result.delivered_via ? 'Result delivered' : 'Result ready'}</Text>
      {result.reason && <OrchestrationReason>{result.reason}</OrchestrationReason>}
      <Text weight="semibold">{result.summary}</Text>
      <Text size="small" tone="faint">Preview</Text><OrchestrationReason>{result.excerpt}</OrchestrationReason>
      <OrchestratorActionRow><Button size="sm" variant="secondary" disabled={state.pending != null} onClick={() => state.read(result.message_id, false)}>{state.expanded === result.message_id ? 'Hide result' : 'View result'}</Button><Button size="sm" variant="secondary" disabled={state.pending != null} onClick={() => state.read(result.message_id, true)}>Copy result</Button></OrchestratorActionRow>
      {state.copied === result.message_id && <Text role="status" size="small">Result copied</Text>}
      {state.pending === result.message_id && <Text role="status" size="small">Reading result…</Text>}
      {state.error?.id === result.message_id && <Notice tone="danger">{state.error.message}</Notice>}
      <ExpandedResult resultId={result.message_id} state={state} />
    </OrchestratorChildCard>
}

export function DelegationResults({ parentId, results, nextMessageId, truncated, loading, onLoadMore, client }: {
  parentId: number
  results: DelegationResult[]
  nextMessageId: number | null
  truncated: boolean
  loading: boolean
  onLoadMore: () => void
  client: HoustonClient
}): React.JSX.Element | null {
  const state = useResultRead(parentId, client)
  if (results.length === 0) return null
  return <section aria-label="Results"><OrchestratorSectionLabel>Results</OrchestratorSectionLabel>
    <div className="grid gap-[var(--space-2)]">{results.map((result) => <ResultCard key={result.message_id} result={result} state={state} />)}</div>
    {truncated && <Text size="small" tone="muted">Showing a page of up to 256 latest child results. More results are available.</Text>}
    {nextMessageId != null && <Button size="sm" variant="secondary" disabled={loading} onClick={onLoadMore}>{loading ? 'Loading results…' : 'Load older results'}</Button>}
  </section>
}
