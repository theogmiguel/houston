import { useCallback, useEffect, useState } from 'react'
import { Button, HistoryEditor, Inline, Text, SettingsTextarea, Stack } from '../ui'
import { isTauri } from '../../houston/host'
import {
  COMMAND_HISTORY_IGNORE_GLOBS_MAX,
  COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX
} from '../../houston/generated/DEFAULTS'
import { SettingsList } from '../ui/settingsPrimitives'
import type { HostInfo } from '../SettingsView'
import { Row, SubHead } from './shared'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

export interface PrivacySectionProps {
  historyCount: number | null
  onClearHistory: () => void
  historyIgnoreGlobs: string[] | null
  onHistoryIgnoreGlobsSet: (globs: string[]) => void
  hostInfo: HostInfo | null
  onRevealSessionDb: () => void
}

export function PrivacySection({
  historyCount,
  onClearHistory,
  historyIgnoreGlobs,
  onHistoryIgnoreGlobsSet,
  hostInfo,
  onRevealSessionDb
}: PrivacySectionProps): React.JSX.Element {
  const [confirmClear, setConfirmClear] = useState(false)
  const [editingIgnoreGlobs, setEditingIgnoreGlobs] = useState(false)
  const [ignoreGlobsDraft, setIgnoreGlobsDraft] = useState('')

  const [browsingData, setBrowsingData] = useState<number | null>(null)
  const [browsingError, setBrowsingError] = useState<string | null>(null)
  const [confirmClearBrowsing, setConfirmClearBrowsing] = useState(false)
  const readBrowsingSize = useCallback(async (): Promise<void> => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      setBrowsingData(await invoke<number>('browser_browsing_data_size'))
    } catch (err) {
      setBrowsingData(null)
      console.warn('browser_browsing_data_size failed', err)
    }
  }, [])
  useEffect(() => {
    void readBrowsingSize()
  }, [readBrowsingSize])
  const clearBrowsingData = useCallback(async (): Promise<void> => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke<number>('browser_clear_browsing_data')
      setBrowsingError(null)
    } catch (err) {
      setBrowsingError(err instanceof Error ? err.message : String(err))
    }
    await readBrowsingSize()
  }, [readBrowsingSize])

  return (
    <>
      <SubHead>What Houston keeps on this machine</SubHead>
      <SettingsList>
        <Row
          title="Command history"
          desc={
            <>
              <Text weight="medium" size="small" tabular>{historyCount ?? '…'}</Text> recorded command
              {historyCount === 1 ? '' : 's'} across all workspaces
            </>
          }
        >
          <Button
            variant="legacy-danger"
            armed={confirmClear}
            onClick={() => {
              if (confirmClear) {
                onClearHistory()
                setConfirmClear(false)
              } else {
                setConfirmClear(true)
              }
            }}
            onBlur={() => setConfirmClear(false)}
          >
            {confirmClear ? 'Click again to clear all history' : 'Clear history…'}
          </Button>
        </Row>
        <Row
          title="History ignore patterns"
          desc="Commands matching these are never recorded. Ships with secret-bearing patterns."
        >
          <Button
            type="button"
            variant="legacy-ghost"
            data-testid="settings-history-ignore-edit"
            onClick={() => {
              setIgnoreGlobsDraft((historyIgnoreGlobs ?? []).join('\n'))
              setEditingIgnoreGlobs(true)
            }}
          >
            {(historyIgnoreGlobs ?? null) === null
              ? 'Edit patterns…'
              : `Edit ${historyIgnoreGlobs!.length} pattern${historyIgnoreGlobs!.length === 1 ? '' : 's'}…`}
          </Button>
        </Row>
        {editingIgnoreGlobs && (
          <HistoryEditor>
            <SettingsTextarea
              autoFocus
              rows={6}
              data-testid="settings-history-ignore-textarea"
              mono
              radius="small"
              placeholder="One glob per line, e.g. aws configure*"
              value={ignoreGlobsDraft}
              onChange={(e) => setIgnoreGlobsDraft(e.target.value)}
            />
            <Stack gap={1} insetTop={1}>
              {(() => {
                const lines = ignoreGlobsDraft.split('\n').filter((l) => l.trim().length > 0)
                const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
                return (
                  <Text weight="medium" size="small" tone="muted" tabular>
                    {lines.length}/{COMMAND_HISTORY_IGNORE_GLOBS_MAX} patterns · longest {longest}/
                    {COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX} chars
                  </Text>
                )
              })()}
            </Stack>
            <Inline gap="small" insetTop>
              <Button
                type="button"
                variant="legacy-ghost"
                data-testid="settings-history-ignore-save"
                onClick={() => {
                  const globs = ignoreGlobsDraft
                    .split('\n')
                    .map((l) => l.trim())
                    .filter((l) => l.length > 0)
                  onHistoryIgnoreGlobsSet(globs)
                  setEditingIgnoreGlobs(false)
                }}
              >
                Save
              </Button>
              <Button
                type="button"
                variant="legacy-ghost"
                onClick={() => setEditingIgnoreGlobs(false)}
              >
                Cancel
              </Button>
            </Inline>
          </HistoryEditor>
        )}
        <Row
          title="Browser pane data"
          desc={
            browsingData === null
              ? 'Cookies, logins and cache kept by browser panes on this channel'
              : (
                  <>
                    <Text weight="medium" size="small" tabular>{formatBytes(browsingData)}</Text> of cookies, logins and
                    cache kept by browser panes on this channel
                  </>
                )
          }
        >
          <Button
            variant="legacy-danger"
            armed={confirmClearBrowsing}
            data-testid="settings-clear-browsing-data"
            onClick={() => {
              if (!confirmClearBrowsing) {
                setConfirmClearBrowsing(true)
                return
              }
              setConfirmClearBrowsing(false)
              void clearBrowsingData()
            }}
            onBlur={() => setConfirmClearBrowsing(false)}
          >
            {confirmClearBrowsing ? 'Click again to clear' : 'Clear browsing data…'}
          </Button>
        </Row>
        {browsingError !== null && (
          <Row title="" desc={browsingError} />
        )}
        <Row
          title="Session database"
          desc="Pane titles, workspaces and status history. Deleting it loses no files."
        >
          {!hostInfo ? (
            <Text weight="medium" size="small" tone="muted">…</Text>
          ) : (
            <div className="flex items-center gap-[var(--space-2)]">
              <Text weight="medium" size="small" tone="secondary" tabular>
                {formatBytes(hostInfo.session_db_bytes)}
              </Text>
              <Button
                type="button"
                variant="legacy-ghost"
                data-testid="settings-reveal-session-db"
                onClick={onRevealSessionDb}
              >
                Reveal…
              </Button>
            </div>
          )}
        </Row>
      </SettingsList>
      <SubHead>What Houston never does</SubHead>
      <SettingsList>
        <Row title="Telemetry" desc="Houston sends no usage data, crash reports or analytics anywhere.">
          <Text weight="medium" size="small" tone="secondary">None</Text>
        </Row>
        <Row
          title="Agent transcripts"
          desc="Houston reads no agent transcripts, only hooks and documented event streams."
        >
          <Text weight="medium" size="small" tone="secondary">Never read</Text>
        </Row>
      </SettingsList>
    </>
  )
}
