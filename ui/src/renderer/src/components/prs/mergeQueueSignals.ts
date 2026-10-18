// The merge queue's boot-path signals, the rail count and the morning notice, kept
// apart from the queue view's controller and model, which load with the page.
import { useEffect, useRef, useState } from 'react'
import type { HoustonClient, MergeQueueAway } from '../../houston/client'
import type { NoticeInput } from '../../notices'

function clockTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

const CODE = 'merge-queue-away'

/** The morning notice's words: what the queue merged and parked unattended. */
export function awayTitle(away: MergeQueueAway): string {
  const merged = away.merged > 0 ? `merged ${away.merged}` : null
  const parked = away.parked > 0 ? `parked ${away.parked}` : null
  return `Merge queue ${[merged, parked].filter(Boolean).join(' and ')} while you were away`
}

/** One workspace-top notice when the user comes back to unattended merges and
 *  parks: on the first snapshot, and when the window regains focus. Review
 *  opens the queue and acknowledges them; dismissing keeps them for the page. */
export function useMergeQueueAwayNotice(
  client: HoustonClient | null,
  selected: string | null,
  push: (input: NoticeInput) => string,
  dismiss: (code: string) => void,
  openQueue: () => void
): void {
  const latest = useRef<{ workspace: string; away: MergeQueueAway } | null>(null)
  const shown = useRef<string | null>(null)
  const actions = useRef({ push, dismiss, openQueue })
  actions.current = { push, dismiss, openQueue }

  const workspace = selected === 'all' ? null : selected
  useEffect(() => {
    latest.current = null
    shown.current = null
    if (!client || !workspace) return
    const show = (): void => {
      const current = latest.current
      if (!current || current.away.merged + current.away.parked === 0) {
        actions.current.dismiss(CODE)
        return
      }
      const signature = `${current.workspace}:${current.away.merged}:${current.away.parked}:${current.away.last_merge_at_ms ?? 0}`
      if (shown.current === signature) return
      shown.current = signature
      actions.current.push({
        code: CODE,
        kind: 'info',
        title: current.away.last_merge_at_ms != null ? `${awayTitle(current.away)}. Last merge ${clockTime(current.away.last_merge_at_ms)}.` : `${awayTitle(current.away)}.`,
        durationMs: null,
        action: {
          label: 'Review',
          onClick: () => {
            client.mergeQueueAcknowledge(current.workspace)
            actions.current.openQueue()
          }
        }
      })
    }
    let first = true
    const off = client.subscribe('merge_queue', (message) => {
      if (message.dir !== workspace && (!message.workspace || message.workspace !== (latest.current?.workspace ?? workspace))) return
      if (!message.workspace) return
      latest.current = { workspace: message.workspace, away: message.away ?? { merged: 0, parked: 0, last_merge_at_ms: null } }
      if (first) {
        first = false
        if (document.hasFocus()) show()
      } else if (latest.current.away.merged + latest.current.away.parked === 0) {
        actions.current.dismiss(CODE)
      }
    })
    window.addEventListener('focus', show)
    client.mergeQueueGet(workspace)
    return () => { off(); window.removeEventListener('focus', show) }
  }, [client, workspace])
}

/** Parked entries across every workspace, for the rail's Pull requests count:
 *  each daemon's summary seeds it and every queue broadcast keeps it current. */
export function useMergeQueueParked(client: HoustonClient | null): number {
  const [parked, setParked] = useState<ReadonlyMap<string, number>>(new Map())
  useEffect(() => {
    setParked(new Map())
    if (!client) return
    const offSummary = client.subscribe('merge_queue_summary', (message) => setParked((current) => {
      const next = new Map(current)
      for (const row of message.parked) next.set(row.workspace, row.parked)
      return next
    }))
    const offQueue = client.subscribe('merge_queue', (message) => {
      if (!message.workspace) return
      const count = message.entries.filter((entry) => entry.status === 'parked').length
      setParked((current) => {
        if ((current.get(message.workspace) ?? 0) === count) return current
        const next = new Map(current)
        next.set(message.workspace, count)
        return next
      })
    })
    client.mergeQueueSummaryGet()
    return () => { offSummary(); offQueue() }
  }, [client])
  let total = 0
  for (const count of parked.values()) total += count
  return total
}
