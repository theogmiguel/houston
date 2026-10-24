import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import { showItemInFolder } from '../../houston/bridge'
import { Button, Inline } from '../ui'
import { formatBytes, Row } from './shared'

type Collect =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; path: string; bytes: number }
  | { phase: 'failed'; error: string }

const DESC =
  'Writes a redacted file for a bug report: versions, sessions without titles or output, hook health and the recent daemon log. It stays on this computer.'

export function folderOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}

/** Asks the daemon to write a redacted diagnostics file and offers its folder. */
export function DiagnosticsFileRow({ client }: { client: HoustonClient | null }): React.JSX.Element {
  const [collect, setCollect] = useState<Collect>({ phase: 'idle' })
  useEffect(() => {
    if (!client) return
    return client.subscribeAll((msg) => {
      if (msg.type !== 'diagnostics_collected') return
      setCollect(
        msg.path
          ? { phase: 'done', path: msg.path, bytes: msg.bytes }
          : { phase: 'failed', error: msg.error ?? 'the daemon wrote no file and gave no reason' }
      )
    })
  }, [client])

  const start = (): void => {
    if (!client) return
    setCollect({ phase: 'running' })
    client.send({ type: 'diagnostics_collect', app_version: __APP_VERSION__ })
  }

  const desc =
    collect.phase === 'done'
      ? `Saved ${collect.path} (${formatBytes(collect.bytes)}). Read it before attaching it to an issue.`
      : collect.phase === 'failed'
        ? `No file was written: ${collect.error}`
        : DESC
  return (
    <Row title="Save diagnostics file" desc={<span data-testid="settings-diagnostics-file-desc">{desc}</span>}>
      <Inline gap="small">
        {collect.phase === 'done' && (
          <Button variant="legacy-ghost" onClick={() => void showItemInFolder(folderOf(collect.path))}>
            Show folder
          </Button>
        )}
        <Button
          variant="legacy-ghost"
          data-testid="settings-diagnostics-file"
          disabled={!client || collect.phase === 'running'}
          onClick={start}
        >
          {collect.phase === 'running' ? 'Saving…' : 'Save file'}
        </Button>
      </Inline>
    </Row>
  )
}
