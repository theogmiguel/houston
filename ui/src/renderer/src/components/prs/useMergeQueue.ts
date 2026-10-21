import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient, MergeQueueAway, MergeQueueEntry, MergeQueueHandOffInfo, MergeQueueLogEntry, MergeQueueSettings, PrMergeMethod } from '../../houston/client'

export interface MergeQueueReply {
  ok: boolean
  number: number
  text: string
}

export interface MergeQueueController {
  /** The workspace the daemon resolved `dir` to; null until the first reply. */
  workspace: string | null
  entries: MergeQueueEntry[]
  /** The last day's merge log, newest first. */
  log: MergeQueueLogEntry[]
  settings: MergeQueueSettings | null
  /** Every queue of the daemon is paused. */
  globalPaused: boolean
  away: MergeQueueAway
  /** Who merges here, as the daemon's reads last said; null before the first. */
  handOff: MergeQueueHandOffInfo | null
  loaded: boolean
  /** Why `dir` has no merge queue, such as a missing GitHub remote. */
  unavailable: string | null
  /** The pull request a request is in flight for; 0 for a workspace-wide one. */
  busy: number | null
  reply: MergeQueueReply | null
  enqueue: (number: number, dependsOn?: number | null) => void
  dequeue: (number: number) => void
  mergeHead: (number: number, expectedHeadSha: string, method: PrMergeMethod) => void
  retry: (number: number) => void
  revert: (number: number) => void
  setPaused: (paused: boolean) => void
  setSettings: (mergeWhenVerified: boolean, command: string, timeLimitMinutes: number) => void
  acknowledge: () => void
  clearReply: () => void
}

const NO_AWAY: MergeQueueAway = { merged: 0, parked: 0, last_merge_at_ms: null }

/** The merge queue of the workspace `dir` belongs to, kept current by the
 *  daemon's broadcasts, and the verbs a person has on it. */
export function useMergeQueue(client: HoustonClient | null, dir: string | null | undefined, active = true): MergeQueueController {
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [entries, setEntries] = useState<MergeQueueEntry[]>([])
  const [log, setLog] = useState<MergeQueueLogEntry[]>([])
  const [settings, setSettingsState] = useState<MergeQueueSettings | null>(null)
  const [globalPaused, setGlobalPaused] = useState(false)
  const [away, setAway] = useState<MergeQueueAway>(NO_AWAY)
  const [handOff, setHandOff] = useState<MergeQueueHandOffInfo | null>(null)
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
    setLog([])
    setSettingsState(null)
    setGlobalPaused(false)
    setAway(NO_AWAY)
    setHandOff(null)
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
      setLog(message.log)
      setSettingsState(message.settings ?? null)
      setGlobalPaused(message.global_paused ?? false)
      setAway(message.away ?? NO_AWAY)
      setHandOff(message.hand_off ?? null)
      setLoaded(true)
    })
    const offSummary = client.subscribe('merge_queue_summary', (message) => setGlobalPaused(message.global_paused))
    const offReply = client.subscribe('merge_queue_reply', (message) => {
      if (message.dir !== dir || message.request !== pending.current) return
      pending.current = null
      setBusy(null)
      setReply({ ok: message.ok, number: message.number, text: message.message ?? (message.ok ? 'Done' : 'The merge queue refused the request') })
    })
    client.mergeQueueGet(dir)
    return () => { offQueue(); offSummary(); offReply() }
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
  const retry = useCallback((number: number) => begin(number, (c, d) => c.mergeQueueRetry(d, number)), [begin])
  const revert = useCallback((number: number) => begin(number, (c, d) => c.mergeQueueRevert(d, number)), [begin])
  const setPaused = useCallback((paused: boolean) => begin(0, (c, d) => c.mergeQueuePause(d, paused)), [begin])
  const setSettings = useCallback((mergeWhenVerified: boolean, command: string, timeLimitMinutes: number) => begin(0, (c, d) => c.mergeQueueSettingsSet(d, mergeWhenVerified, command, timeLimitMinutes)), [begin])
  const acknowledge = useCallback(() => { if (client && dir) client.mergeQueueAcknowledge(dir) }, [client, dir])
  const clearReply = useCallback(() => setReply(null), [])

  return { workspace, entries, log, settings, globalPaused, away, handOff, loaded, unavailable, busy, reply, enqueue, dequeue, mergeHead, retry, revert, setPaused, setSettings, acknowledge, clearReply }
}
