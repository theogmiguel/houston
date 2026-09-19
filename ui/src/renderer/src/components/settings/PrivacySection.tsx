import { useCallback, useEffect, useState } from 'react'
import { BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER } from '../buttonChrome'
import { isTauri } from '../../houston/host'
import {
  COMMAND_HISTORY_IGNORE_GLOBS_MAX,
  COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX
} from '../../houston/generated/DEFAULTS'
import { SettingsList } from '../settingsPrimitives'
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
      <div className="mb-[var(--space-5)]">
        <div className="text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.25] text-[var(--text-primary)]">Privacy &amp; data</div>
        <div className="mt-[var(--space-1-5)] text-[length:var(--tr-text-base)] leading-[1.6] text-[var(--text-muted)] max-w-[72ch]">
          What Houston keeps on this machine, and what it never sends anywhere. Command
          history is captured via shell integration (Terminal → Shell integration).
        </div>
      </div>
      <SubHead>What Houston stores</SubHead>
      <SettingsList>
        <Row
          title="Command history"
          desc={
            <>
              <span className="tabular-nums">{historyCount ?? '…'}</span> recorded command
              {historyCount === 1 ? '' : 's'} across all workspaces
            </>
          }
        >
          <button
            className={`btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER} ${confirmClear ? BTN_GHOST_DANGER_ARM : ''}`}
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
          </button>
        </Row>
        <Row
          title="History ignore patterns"
          desc="Commands matching these are never recorded. Ships with secret-bearing patterns."
        >
          <button
            type="button"
            className={`btn ${BTN_GHOST}`}
            data-testid="settings-history-ignore-edit"
            onClick={() => {
              setIgnoreGlobsDraft((historyIgnoreGlobs ?? []).join('\n'))
              setEditingIgnoreGlobs(true)
            }}
          >
            {(historyIgnoreGlobs ?? null) === null
              ? 'Edit patterns…'
              : `Edit ${historyIgnoreGlobs!.length} pattern${historyIgnoreGlobs!.length === 1 ? '' : 's'}…`}
          </button>
        </Row>
        {editingIgnoreGlobs && (
          <div className="px-[14px] pb-[12px] pt-[2px] border-t border-t-[var(--divider)]">
            <textarea
              autoFocus
              rows={6}
              data-testid="settings-history-ignore-textarea"
              className="w-full bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[6px] px-2 leading-[1.5]"
              placeholder="One glob per line, e.g. aws configure*"
              value={ignoreGlobsDraft}
              onChange={(e) => setIgnoreGlobsDraft(e.target.value)}
            />
            <div className="mt-[4px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
              {(() => {
                const lines = ignoreGlobsDraft.split('\n').filter((l) => l.trim().length > 0)
                const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
                return (
                  <span className="tabular-nums">
                    {lines.length}/{COMMAND_HISTORY_IGNORE_GLOBS_MAX} patterns · longest {longest}/
                    {COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX} chars
                  </span>
                )
              })()}
            </div>
            <div className="mt-[8px] flex items-center gap-2">
              <button
                type="button"
                className={`btn ${BTN_GHOST}`}
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
              </button>
              <button
                type="button"
                className={`btn ${BTN_GHOST}`}
                onClick={() => setEditingIgnoreGlobs(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <Row
          title="Browser pane data"
          desc={
            browsingData === null
              ? 'Cookies, logins and cache kept by browser panes on this channel'
              : (
                  <>
                    <span className="tabular-nums">{formatBytes(browsingData)}</span> of cookies, logins and
                    cache kept by browser panes on this channel
                  </>
                )
          }
        >
          <button
            data-testid="settings-clear-browsing-data"
            className={`btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER} ${confirmClearBrowsing ? BTN_GHOST_DANGER_ARM : ''}`}
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
          </button>
        </Row>
        {browsingError !== null && (
          <Row title="" desc={browsingError} />
        )}
        <Row
          title="Session database"
          desc="Pane titles, workspaces and status history. Deleting it loses no files."
        >
          {!hostInfo ? (
            <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">…</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] tabular-nums">
                {formatBytes(hostInfo.session_db_bytes)}
              </span>
              <button
                type="button"
                className={`btn ${BTN_GHOST}`}
                data-testid="settings-reveal-session-db"
                onClick={onRevealSessionDb}
              >
                Reveal…
              </button>
            </div>
          )}
        </Row>
      </SettingsList>
      <SubHead>What Houston does not do</SubHead>
      <SettingsList>
        <Row title="Telemetry" desc="Houston sends no usage data, crash reports or analytics anywhere">
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">None</span>
        </Row>
        <Row
          title="Agent transcripts"
          desc="Houston reads no agent transcripts — only hooks and documented event streams."
        >
          <span className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]">Never read</span>
        </Row>
      </SettingsList>
    </>
  )
}
