import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient } from './client'

/// The factory's limits and the counts they are measured against, from
/// `factory_settings`. The daemon broadcasts it after every set.
export interface FactorySettings {
  liveRunsMax: number
  needsYouMax: number
  liveRuns: number
  needsYou: number
}

/// Both limits accept 1..=16; the daemon refuses anything else.
export const FACTORY_LIMIT_MIN = 1
export const FACTORY_LIMIT_MAX = 16

// Task events arrive in bursts (a start sends changed, run and snapshot
// messages); one re-read per window keeps the counts current without a storm.
export const FACTORY_REFRESH_MS = 500

/// Settings ▸ Tasks ▸ Factory and the Factory page's Limits read the same
/// broadcast; a refusal is kept until the next successful set. The daemon
/// broadcasts only when a limit changes, so task events trigger a re-read.
export function useFactorySettings(client: Pick<HoustonClient, 'subscribe' | 'send'> | null): {
  settings: FactorySettings | null
  refusal: string | null
  setLimits: (liveRunsMax: number, needsYouMax: number) => void
} {
  const [settings, setSettings] = useState<FactorySettings | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = useRef(false)

  useEffect(() => {
    setSettings(null)
    setRefusal(null)
    pending.current = false
    if (!client) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false
    let stale = false
    const request = (): void => {
      inFlight = true
      client.send({ type: 'factory_settings_get' })
    }
    // At most one timer and one request at a time; an event during a request re-reads after it answers.
    const refresh = (): void => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        if (inFlight) stale = true
        else request()
      }, FACTORY_REFRESH_MS)
    }
    const offSettings = client.subscribe('factory_settings', (msg) => {
      inFlight = false
      pending.current = false
      setRefusal(null)
      setSettings({ liveRunsMax: msg.live_runs_max, needsYouMax: msg.needs_you_max, liveRuns: msg.live_runs, needsYou: msg.needs_you })
      if (stale) {
        stale = false
        refresh()
      }
    })
    const offRefused = client.subscribe('task_refused', (msg) => {
      if (!pending.current) return
      pending.current = false
      setRefusal(msg.message)
    })
    const offChanged = client.subscribe('task_changed', refresh)
    const offRun = client.subscribe('task_run_changed', refresh)
    const offSnapshot = client.subscribe('task_snapshot', refresh)
    request()
    return () => {
      if (timer !== null) clearTimeout(timer)
      offSettings()
      offRefused()
      offChanged()
      offRun()
      offSnapshot()
    }
  }, [client])

  const setLimits = useCallback((liveRunsMax: number, needsYouMax: number) => {
    if (!client) return
    pending.current = true
    setRefusal(null)
    client.send({ type: 'factory_settings_set', live_runs_max: liveRunsMax, needs_you_max: needsYouMax })
  }, [client])

  return { settings, refusal, setLimits }
}
