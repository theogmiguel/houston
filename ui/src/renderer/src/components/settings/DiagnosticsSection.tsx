import { useEffect, useRef, useState } from 'react'
import { BTN_GHOST } from '../buttonChrome'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { AgentHookState } from '../../houston/generated/AgentHookState'
import type { HostInfo } from '../SettingsView'
import { SettingsList } from '../settingsPrimitives'
import { Row, SubHead } from './shared'

function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const HOOK_LABELS: Partial<Record<AgentKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'opencode',
  cursor: 'Cursor',
  grok: 'Grok'
}

function DiagRead({
  label,
  value,
  mono,
  numeric
}: {
  label: string
  value: string
  mono?: boolean
  numeric?: boolean
}): React.JSX.Element {
  return (
    <div
      data-testid="settings-diagnostics-read"
      className="rounded-[8px] border border-[var(--border)] bg-[var(--content-bg)] px-[10px] py-[8px]"
    >
      <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">{label}</div>
      <div
        className={`mt-[2px] text-[var(--text-primary)] ${mono ? 'font-mono [font-size:var(--tr-text-small-size)] break-all' : '[font-size:var(--tr-text-ui-size)] font-medium'} ${numeric ? 'tabular-nums' : ''}`}
      >
        {value}
      </div>
    </div>
  )
}

function DiagnosticsCopyRow({
  hostInfo,
  agentHooks
}: {
  hostInfo: HostInfo
  agentHooks: AgentHookState[] | null
}): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(timerRef.current ?? undefined), [])

  const copy = (): void => {
    const hookLines = (agentHooks ?? [])
      .map((h) => `  ${HOOK_LABELS[h.provider] ?? h.provider}: ${h.enabled && h.installed ? 'wired' : 'not wired'}`)
      .join('\n')
    const text = [
      `Houston diagnostics — v${__APP_VERSION__}`,
      `Channel: ${hostInfo.channel}`,
      `State directory: ${hostInfo.state_dir}`,
      `Process: pid ${hostInfo.pid}`,
      `Port: ${hostInfo.port}`,
      `Protocol version: ${hostInfo.protocol_version}`,
      `Build: ${hostInfo.build_commit}`,
      `Uptime: ${formatUptime(hostInfo.uptime_ms)}`,
      `Live sessions: ${hostInfo.live_sessions}`,
      `Deferred by restore budget: ${hostInfo.restore_deferred} of ${hostInfo.restore_budget}`,
      `Orchestration depth in use: ${hostInfo.orchestration_depth_in_use} of ${hostInfo.orchestration_max_depth}`,
      `Mailbox files on disk: ${hostInfo.mailbox_files_on_disk}`,
      'Hooks:',
      hookLines
    ].join('\n')
    const writeText =
      typeof navigator !== 'undefined'
        ? navigator.clipboard?.writeText?.bind(navigator.clipboard)
        : undefined
    clearTimeout(timerRef.current ?? undefined)
    const settle = (next: 'copied' | 'error'): void => {
      setState(next)
      timerRef.current = setTimeout(() => setState('idle'), 2000)
    }
    if (!writeText) {
      settle('error')
      return
    }
    writeText(text).then(
      () => settle('copied'),
      () => settle('error')
    )
  }

  return (
    <Row title="Copy diagnostics" desc="This page as text, for a bug report. No file contents, no secrets.">
      <button
        type="button"
        className={`btn ${BTN_GHOST}`}
        data-testid="settings-diagnostics-copy"
        onClick={copy}
      >
        {state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : 'Copy'}
      </button>
    </Row>
  )
}

export interface DiagnosticsSectionProps {
  hostInfo: HostInfo | null
  agentHooks: AgentHookState[] | null
  onOpenHooks: () => void
  onOpenLogsFolder: () => void
}

export function DiagnosticsSection({
  hostInfo,
  agentHooks,
  onOpenHooks,
  onOpenLogsFolder
}: DiagnosticsSectionProps): React.JSX.Element {
  return (
    <>
      <div className="mb-[14px] flex items-center gap-[8px]">
        <div className="text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.25] text-[var(--text-primary)]">
          Diagnostics
        </div>
        {hostInfo?.channel === 'dev' && (
          <span
            data-testid="settings-diagnostics-dev-badge"
            className="font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] py-[2px] px-[5px] rounded-[4px] bg-[color-mix(in_srgb,var(--warn)_18%,transparent)] text-[var(--warn)]"
          >
            DEV
          </span>
        )}
      </div>
      <div className="mb-[14px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
        Eleven values the daemon has always known and never showed. Read-only by design —
        these are facts about what is running, not preferences. When something is wrong,
        this is the page you screenshot.
      </div>

      {!hostInfo ? (
        <div className="">
          <Row title="Loading…" desc="Asking the daemon for its own vitals." />
        </div>
      ) : (
        <>
          <SubHead>
            Daemon
          </SubHead>
          <div
            data-testid="settings-diagnostics-daemon"
            className="grid grid-cols-2 gap-[10px] mb-[18px]"
          >
            <DiagRead label="Channel" value={hostInfo.channel} />
            <DiagRead label="State directory" value={hostInfo.state_dir} mono />
            <DiagRead label="Process" value={`pid ${hostInfo.pid}`} />
            <DiagRead label="Port" value={String(hostInfo.port)} />
            <DiagRead label="Protocol version" value={String(hostInfo.protocol_version)} />
            <DiagRead label="Uptime" value={formatUptime(hostInfo.uptime_ms)} numeric />
          </div>

          <SubHead>
            Sessions
          </SubHead>
          <div
            data-testid="settings-diagnostics-sessions"
            className="grid grid-cols-2 gap-[10px] mb-[18px]"
          >
            <DiagRead label="Live sessions" value={String(hostInfo.live_sessions)} numeric />
            <DiagRead
              label="Deferred by restore budget"
              value={`${hostInfo.restore_deferred} of ${hostInfo.restore_budget}`}
              numeric
            />
            <DiagRead
              label="Orchestration depth in use"
              value={`${hostInfo.orchestration_depth_in_use} of ${hostInfo.orchestration_max_depth}`}
              numeric
            />
            <DiagRead
              label="Mailbox files on disk"
              value={String(hostInfo.mailbox_files_on_disk)}
              numeric
            />
          </div>

          <SubHead>
            Hooks
          </SubHead>
          <div
            data-testid="settings-diagnostics-hooks"
            className="border border-[var(--border)] rounded-[10px] bg-[var(--card-bg)] px-[14px] py-[11px] mb-[18px]"
          >
            {!agentHooks ? (
              <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
                Asking the daemon what is installed…
              </div>
            ) : (
              (() => {
                const wired = agentHooks.filter((h) => h.enabled && h.installed)
                const unwired = agentHooks.filter((h) => !(h.enabled && h.installed))
                return (
                  <>
                    <div className="[font-size:var(--tr-text-small-size)] font-medium text-[var(--text-primary)]">
                      Status hooks wired{' '}
                      <span className="font-normal text-[var(--text-muted)] tabular-nums">
                        {wired.length} of {agentHooks.length} detected CLIs
                      </span>
                    </div>
                    <div className="mt-[10px] flex flex-wrap gap-[14px]">
                      {agentHooks.map((h) => {
                        const isWired = h.enabled && h.installed
                        return (
                          <span
                            key={h.provider}
                            className={`flex items-center gap-[6px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] ${
                              isWired ? 'text-[var(--text-secondary)]' : 'text-[var(--warn)]'
                            }`}
                          >
                            <span
                              className="inline-block w-[6px] h-[6px] rounded-full flex-none"
                              style={{ background: isWired ? 'var(--ok)' : 'var(--warn)' }}
                            />
                            {HOOK_LABELS[h.provider] ?? h.provider}
                            {!isWired && ' — not wired'}
                          </span>
                        )
                      })}
                    </div>
                    {unwired.length > 0 && (
                      <div className="cap-warn mt-[10px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.4] text-[var(--warn)]">
                        An unwired CLI still runs — Houston just cannot tell whether its agent is
                        working, idle or waiting on you. Its panes show no state dot.
                      </div>
                    )}
                    <button
                      type="button"
                      className={`${BTN_GHOST} mt-[10px]`}
                      data-testid="settings-diagnostics-open-hooks"
                      onClick={onOpenHooks}
                    >
                      Open Agent setup
                    </button>
                  </>
                )
              })()
            )}
          </div>

        </>
      )}

      <SubHead>
        Logs
      </SubHead>
      <SettingsList>
        <Row
          title="Daemon logs"
          desc={
            hostInfo
              ? `Open this channel's (${hostInfo.channel}) log folder in your file manager`
              : 'Open this channel\'s log folder in your file manager'
          }
        >
          <button className={`btn ${BTN_GHOST}`} onClick={onOpenLogsFolder}>
            Open folder
          </button>
        </Row>
        {hostInfo && <DiagnosticsCopyRow hostInfo={hostInfo} agentHooks={agentHooks} />}
      </SettingsList>
    </>
  )
}
