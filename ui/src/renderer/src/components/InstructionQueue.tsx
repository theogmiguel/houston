import { useEffect, useRef, useState } from 'react'
import type { HoustonClient } from '../houston/client'
import type { InstructionQueueSnapshot } from '../houston/generated/InstructionQueueSnapshot'
import type { InstructionDetail } from '../houston/generated/InstructionDetail'
import type { InstructionInfo } from '../houston/generated/InstructionInfo'
import type { InstructionState } from '../houston/generated/InstructionState'
import { Button, DetailsDisclosure, Notice } from './ui'
import { Text } from './ui/Text'
import { OrchestrationBody, OrchestrationInset, OrchestrationReason } from './ui/OrchestrationContent'
import { OrchestratorActionRow } from './ui/OrchestratorOverview'

const STATE_LABEL: Record<InstructionState, string> = {
  queued: 'Queued', held_after_recovery: 'Held after recovery', delivered: 'Delivered', cancelled: 'Cancelled', uncertain: 'Uncertain'
}

export function InstructionQueue({ sessionId, client, onOpenPane }: { sessionId: number; client: HoustonClient; onOpenPane: () => void }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<InstructionQueueSnapshot | null>(null)
  const [detail, setDetail] = useState<InstructionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const scope = useRef(sessionId)
  scope.current = sessionId
  const request = useRef<{ id: string; kind: 'get' | 'cancel' | 'resume' } | null>(null)
  useEffect(() => {
    request.current = null
    setSnapshot(null)
    setDetail(null)
    setError(null)
    setPending(null)
    const offQueue = client.subscribe('instruction_queue', (message) => {
      if (scope.current !== sessionId || message.snapshot.session !== sessionId) return
      setSnapshot(message.snapshot)
      const action = request.current
      const item = action && message.snapshot.items.find((entry) => entry.id === action.id)
      if (action && (action.kind === 'cancel' && item?.state === 'cancelled' || action.kind === 'resume' && item != null && item.state !== 'held_after_recovery')) {
        request.current = null
        setPending(null)
      }
    })
    const offDetail = client.subscribe('instruction_detail', (message) => {
      if (scope.current !== sessionId || message.detail.session !== sessionId || message.detail.instruction.id !== request.current?.id || request.current.kind !== 'get') return
      request.current = null
      setPending(null)
      setDetail(message.detail)
    })
    const offRefused = client.subscribe('instruction_refused', (message) => {
      if (scope.current !== sessionId || message.session !== sessionId || (message.instruction_id != null && message.instruction_id !== request.current?.id)) return
      request.current = null
      setPending(null)
      setError(message.message)
    })
    client.instructionQueueList(sessionId)
    return () => { request.current = null; offQueue(); offDetail(); offRefused() }
  }, [client, sessionId])
  useEffect(() => {
    if (pending == null) return
    const timer = window.setTimeout(() => {
      request.current = null
      setPending(null)
      setError('Instruction request did not complete. Refresh the queue before trying again.')
    }, 10_000)
    return () => window.clearTimeout(timer)
  }, [pending])
  const mutate = (id: string, kind: 'get' | 'cancel' | 'resume'): void => {
    setError(null)
    request.current = { id, kind }
    setPending(id)
    if (kind === 'get') client.instructionGet(sessionId, id)
    else if (kind === 'cancel') client.instructionCancel(sessionId, id)
    else client.instructionResume(sessionId, id)
  }
  const summary = snapshot ? `Instructions · ${snapshot.queued_count} queued · ${snapshot.held_count} held · ${snapshot.uncertain_count} uncertain` : 'Instructions'
  return <div className="grid gap-[var(--space-2)]">{error && <Notice tone="danger">{error}</Notice>}<DetailsDisclosure summary={summary} defaultOpen={!!snapshot && (snapshot.held_count > 0 || snapshot.uncertain_count > 0)}><OrchestrationInset>
    {!snapshot && !error && <Text size="small" role="status">Loading instruction queue…</Text>}
    {snapshot?.hold_reason && <OrchestrationReason>{snapshot.hold_reason}</OrchestrationReason>}
    <Button size="sm" variant="secondary" disabled={pending != null} onClick={() => { setError(null); client.instructionQueueList(sessionId) }}>Refresh instructions</Button>
    {snapshot?.items.length === 0 && <Text size="small" tone="muted">No recorded instructions.</Text>}
    <ol className="grid gap-[var(--space-2)]">{snapshot?.items.map((item, index) => <InstructionItem key={item.id} item={item} index={index} pending={pending} detail={detail} mutate={mutate} onOpenPane={onOpenPane} />)}</ol>
    {snapshot?.truncated && <Text size="small" tone="muted">Showing up to 32 active instructions and recent history; earlier history is omitted.</Text>}
  </OrchestrationInset></DetailsDisclosure></div>
}

function InstructionItem({ item, index, pending, detail, mutate, onOpenPane }: {
  item: InstructionInfo
  index: number
  pending: string | null
  detail: InstructionDetail | null
  mutate: (id: string, kind: 'get' | 'cancel' | 'resume') => void
  onOpenPane: () => void
}): React.JSX.Element {
  return <li className="grid gap-[var(--space-1)]">
      <Text size="small" weight="semibold">{index + 1}. {STATE_LABEL[item.state]} · {item.mode}</Text>
      <Text size="small" mono tone="muted">{item.id}{item.request_id != null ? ` · request ${item.request_id}` : ''}</Text>
      <Text size="small" tone="faint">Created {new Date(item.created_at).toLocaleString()} · Updated {new Date(item.updated_at).toLocaleString()}</Text>
      <Text size="small" tone="faint">Preview</Text><OrchestrationReason>{item.preview}</OrchestrationReason>
      {item.hold_reason && <OrchestrationReason>{item.hold_reason}</OrchestrationReason>}
      {item.state === 'uncertain' && <OrchestrationReason>Delivery is uncertain. Inspect before cancelling or sending a new instruction in the pane.</OrchestrationReason>}
      <OrchestratorActionRow>
        <Button size="sm" variant="secondary" disabled={pending != null} onClick={() => mutate(item.id, 'get')}>Inspect instruction</Button>
        {(['queued', 'held_after_recovery', 'uncertain'] as InstructionState[]).includes(item.state) && <Button size="sm" variant="ghost" disabled={pending != null} onClick={() => mutate(item.id, 'cancel')}>Cancel instruction</Button>}
        {item.state === 'held_after_recovery' && <Button size="sm" variant="secondary" disabled={pending != null} onClick={() => mutate(item.id, 'resume')}>Resume instruction</Button>}
        {item.state === 'uncertain' && <Button size="sm" variant="secondary" onClick={onOpenPane}>Open pane</Button>}
      </OrchestratorActionRow>
      {pending === item.id && <Text size="small" role="status">Waiting for confirmation…</Text>}
      {detail?.instruction.id === item.id && <OrchestrationBody>{detail.body}</OrchestrationBody>}
    </li>
}
