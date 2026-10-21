import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { HostInfo } from '../SettingsView'
import { Button, Notice, Readout, ReadoutGrid, Stack } from '../ui'
import { SettingsList } from '../ui/settingsPrimitives'
import { formatBytes, Row, SubHead } from './shared'

// Below this, reclaiming frees too little to be worth closing every pane for.
export const RECLAIM_HINT_BYTES = 32 * 1024 * 1024

type Reclaim =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; before: number; after: number }
  | { phase: 'refused'; reason: string }

function reclaimDesc(live: number): string {
  if (live > 0) {
    return `Close or sleep all ${live} live ${live === 1 ? 'session' : 'sessions'} first: compacting holds the database while it runs.`
  }
  return 'Compacts the session database and returns its free pages to the disk. Runs only when you ask.'
}

export function StorageDiagnostics({
  hostInfo,
  client
}: {
  hostInfo: HostInfo
  client: HoustonClient | null
}): React.JSX.Element {
  const [reclaim, setReclaim] = useState<Reclaim>({ phase: 'idle' })
  useEffect(() => {
    if (!client) return
    return client.subscribeAll((msg) => {
      if (msg.type !== 'storage_reclaimed') return
      setReclaim(
        msg.refusal
          ? { phase: 'refused', reason: msg.refusal }
          : { phase: 'done', before: msg.before_bytes, after: msg.after_bytes }
      )
    })
  }, [client])

  const live = hostInfo.live_sessions
  const free = hostInfo.session_db_free_bytes
  const start = (): void => {
    if (!client) return
    setReclaim({ phase: 'running' })
    client.send({ type: 'storage_reclaim' })
  }

  return (
    <>
      <SubHead>Storage</SubHead>
      <ReadoutGrid data-testid="settings-diagnostics-storage" spaceAfter>
        <Readout label="Session database" value={formatBytes(hostInfo.session_db_bytes)} tabular />
        <Readout label="Write-ahead log" value={formatBytes(hostInfo.session_db_wal_bytes)} tabular />
        <Readout label="Reclaimable" value={formatBytes(free)} tabular />
        <Readout label="Scrollback" value={formatBytes(hostInfo.scrollback_bytes)} tabular />
        <Readout label="Logs" value={formatBytes(hostInfo.logs_bytes)} tabular />
      </ReadoutGrid>
      <SettingsList>
        <Row title="Reclaim space" desc={reclaimDesc(live)}>
          <Button
            variant="legacy-ghost"
            data-testid="settings-storage-reclaim"
            disabled={!client || live > 0 || reclaim.phase === 'running'}
            onClick={start}
          >
            {reclaim.phase === 'running' ? 'Reclaiming…' : 'Reclaim space'}
          </Button>
        </Row>
      </SettingsList>
      <Stack gap="medium" insetTop="medium">
        {free >= RECLAIM_HINT_BYTES && reclaim.phase !== 'done' && (
          <Notice tone="info" data-testid="settings-storage-hint">
            {formatBytes(free)} of the session database is free space that Reclaim space can return to the disk.
          </Notice>
        )}
        {reclaim.phase === 'done' && (
          <Notice tone="info" data-testid="settings-storage-result">
            Reclaimed {formatBytes(Math.max(0, reclaim.before - reclaim.after))}: the session database went from{' '}
            {formatBytes(reclaim.before)} to {formatBytes(reclaim.after)}.
          </Notice>
        )}
        {reclaim.phase === 'refused' && (
          <Notice tone="warn" data-testid="settings-storage-result">
            {reclaim.reason}
          </Notice>
        )}
      </Stack>
    </>
  )
}
