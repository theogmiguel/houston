import { useEffect, useState } from 'react'
import type { HoustonClient } from './client'
import type { HarnessAttention } from './generated/HarnessAttention'

export function useHarnessSignals(client: HoustonClient | null): HarnessAttention[] {
  const [rows, setRows] = useState<HarnessAttention[]>([])

  useEffect(() => {
    setRows([])
    if (!client) return
    const offOverview = client.subscribe('harness_overview', (msg) => setRows(msg.rows))
    const offChanged = client.subscribe('harness_changed', () => client.harnessOverviewGet())
    client.harnessOverviewGet()
    return () => {
      offOverview()
      offChanged()
    }
  }, [client])

  return rows
}
