import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient, MergeQueueEntry, MergeQueueMerge, PrMergeMethod } from '../../houston/client'

export interface MergeQueueReply {
  ok: boolean
  number: number
  text: string
}

export interface MergeQueueController {
  /** The workspace the daemon resolved `dir` to; null until the first reply. */
  workspace: string | null
  entries: MergeQueueEntry[]
  merged: MergeQueueMerge[]
  loaded: boolean
  /** Why `dir` has no merge queue, such as a missing GitHub remote. */
  unavailable: string | null
  /** The pull request a request is in flight for. */
  busy: number | null
  reply: MergeQueueReply | null
  enqueue: (number: number, dependsOn?: number | null) => void
  dequeue: (number: number) => void
  mergeHead: (number: number, expectedHeadSha: string, method: PrMergeMethod) => void
  clearReply: () => void
}

/** The merge queue of the workspace `dir` belongs to, kept current by the
 *  daemon's broadcasts, and the three verbs a person has on it. */
export function useMergeQueue(client: HoustonClient | null, dir: string | null | undefined, active = true): MergeQueueController {
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [entries, setEntries] = useState<MergeQueueEntry[]>([])
  const [merged, setMerged] = useState<MergeQueueMerge[]>([])
  const [loaded, setLoaded] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [reply, setReply] = useState<MergeQueueReply | null>(null)
  const workspaceRef = useRef<string | null>(null)
  const pending = useRef<number | null>(null)

  useEffect(() => {
    workspaceRef.current = null
    pending.current = null
    setWorkspace(null)
    setEntries([])
    setMerged([])
    setLoaded(false)
    setUnavailable(null)
    setBusy(null)
    setReply(null)
    if (!client || !dir || !active) return
    const offQueue = client.subscribe('merge_queue', (message) => {
      const direct = message.dir === dir
      if (!direct && (workspaceRef.current === null || message.workspace !== workspaceRef.current)) return
      if (direct) {
        workspaceRef.current = message.workspace || null
        setWorkspace(message.workspace || null)
        setUnavailable(message.message ?? null)
      }
      setEntries(message.entries)
      setMerged(message.merged)
      setLoaded(true)
    })
    const offReply = client.subscribe('merge_queue_reply', (message) => {
      if (message.dir !== dir || message.request !== pending.current) return
      pending.current = null
      setBusy(null)
      setReply({ ok: message.ok, number: message.number, text: message.message ?? (message.ok ? 'Done' : 'The merge queue refused the request') })
    })
    client.mergeQueueGet(dir)
    return () => { offQueue(); offReply() }
  }, [client, dir, active])

  const begin = useCallback((number: number, send: (client: HoustonClient, dir: string) => number) => {
    if (!client || !dir || pending.current !== null) return
    setBusy(number)
    setReply(null)
    pending.current = send(client, dir)
  }, [client, dir])

  const enqueue = useCallback((number: number, dependsOn: number | null = null) => begin(number, (c, d) => c.mergeQueueEnqueue(d, number, dependsOn)), [begin])
  const dequeue = useCallback((number: number) => begin(number, (c, d) => c.mergeQueueDequeue(d, number)), [begin])
  const mergeHead = useCallback((number: number, expectedHeadSha: string, method: PrMergeMethod) => begin(number, (c, d) => c.mergeQueueMergeHead(d, number, expectedHeadSha, method)), [begin])
  const clearReply = useCallback(() => setReply(null), [])

  return { workspace, entries, merged, loaded, unavailable, busy, reply, enqueue, dequeue, mergeHead, clearReply }
}
