import { useEffect, useRef } from 'react'
import type { HoustonClient, MergeQueueAway } from '../../houston/client'
import type { NoticeInput } from '../../notices'
import { clockTime } from './mergeQueueModel'

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
  workspace: string | null,
  push: (input: NoticeInput) => string,
  dismiss: (code: string) => void,
  openQueue: () => void
): void {
  const latest = useRef<{ workspace: string; away: MergeQueueAway } | null>(null)
  const shown = useRef<string | null>(null)
  const actions = useRef({ push, dismiss, openQueue })
  actions.current = { push, dismiss, openQueue }

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
