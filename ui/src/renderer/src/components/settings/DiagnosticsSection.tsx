import { LazyLegacyButton } from '../ui/LazyLegacyButtonRoles'
import { useEffect, useRef, useState } from 'react'
import { Button, DevBadge, HookPanel, HookStatusList, Readout, ReadoutGrid, HookStatus, Stack, Text } from '../ui'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { AgentHookState } from '../../houston/generated/AgentHookState'
import type { HostInfo } from '../SettingsView'
import { SettingsList } from '../ui/settingsPrimitives'
import { useSessions } from '../../sessionsStore'
import { Table } from '../ui/Table'
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
  tabular
}: {
  label: string
  value: string
  mono?: boolean
  tabular?: boolean
}): React.JSX.Element {
  return <Readout data-testid="settings-diagnostics-read" label={label} value={value} mono={mono} tabular={tabular} />
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
      <Button
        variant="legacy-ghost"
        data-testid="settings-diagnostics-copy"
        onClick={copy}
      >
        {state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : 'Copy'}
      </Button>
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
  const sessions = useSessions()
  return (
    <>

      {!hostInfo ? (
        <div>
          <Row title="Loading…" desc="Asking the daemon for its own vitals." />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-[var(--space-2)]">
            <SubHead>Process</SubHead>
            {hostInfo.channel === 'dev' && (
              <DevBadge data-testid="settings-diagnostics-dev-badge">
                DEV
              </DevBadge>
            )}
          </div>
          <ReadoutGrid data-testid="settings-diagnostics-daemon" spaceAfter>
            <DiagRead label="Channel" value={hostInfo.channel} />
            <DiagRead label="State directory" value={hostInfo.state_dir} mono />
            <DiagRead label="Process" value={`pid ${hostInfo.pid}`} />
            <DiagRead label="Port" value={String(hostInfo.port)} />
            <DiagRead label="Protocol version" value={String(hostInfo.protocol_version)} />
            <DiagRead label="Uptime" value={formatUptime(hostInfo.uptime_ms)} tabular />
          </ReadoutGrid>

            <SubHead>
            Sessions
          </SubHead>
          <ReadoutGrid data-testid="settings-diagnostics-sessions" spaceAfter>
            <DiagRead label="Live sessions" value={String(hostInfo.live_sessions)} tabular />
            <DiagRead
              label="Deferred by restore budget"
              value={`${hostInfo.restore_deferred} of ${hostInfo.restore_budget}`}
              tabular
            />
            <DiagRead
              label="Orchestration depth in use"
              value={`${hostInfo.orchestration_depth_in_use} of ${hostInfo.orchestration_max_depth}`}
              tabular
            />
            <DiagRead
              label="Mailbox files on disk"
              value={String(hostInfo.mailbox_files_on_disk)}
              tabular
            />
          </ReadoutGrid>

          <div data-testid="daemon-live-sessions">
            <SubHead>Sessions {sessions.size} live</SubHead>
            <Table
              aria-label="Live sessions"
              rows={[...sessions.values()].map((session) => ({
                id: session.id,
                title: session.title || session.codename,
                workspace: session.project_dir.split(/[\\/]/).filter(Boolean).at(-1) ?? session.project_dir,
                agent: session.agent,
                status: session.status ?? (session.state === 'exited' ? 'done' : session.state)
              }))}
              getRowId={(session) => String(session.id)}
              empty={{ heading: 'No live sessions', description: 'Sessions appear here while they are running.' }}
              columns={[
                { key: 'title', header: 'Session' },
                { key: 'workspace', header: 'Workspace', tone: 'muted' },
                { key: 'agent', header: 'Agent', tone: 'muted' },
                { key: 'status', header: 'Status', tone: 'muted' }
              ]}
            />
          </div>

          <SubHead>
            Hooks
          </SubHead>
          <HookPanel data-testid="settings-diagnostics-hooks">
            {!agentHooks ? (
                      <Text weight="medium" size="small" as="div" tone="muted">
                        Asking the daemon what is installed…
                      </Text>
            ) : (
              (() => {
                const wired = agentHooks.filter((h) => h.enabled && h.installed)
                const unwired = agentHooks.filter((h) => !(h.enabled && h.installed))
                return (
                  <>
                    <Text size="small" as="div" tone="primary">
                      <Text size="small" as="span" weight="medium">Status hooks wired </Text>
                      <Text size="small" as="span" weight="body" tone="muted" tabular>
                        {wired.length} of {agentHooks.length} detected CLIs
                      </Text>
                    </Text>
                    <HookStatusList>
                      {agentHooks.map((h) => {
                        const isWired = h.enabled && h.installed
                        return (
                          <HookStatus key={h.provider} wired={isWired}>
                            {HOOK_LABELS[h.provider] ?? h.provider}
                            {!isWired && ' — not wired'}
                          </HookStatus>
                        )
                      })}
                    </HookStatusList>
                    <Stack gap="medium" insetTop="medium" align="start">
                      {unwired.length > 0 && (
                        <Text as="div" size="small" weight="small" tone="warn" leading="tight">
                          An unwired CLI still runs — Houston just cannot tell whether its agent is
                          working, idle or waiting on you. Its panes show no state dot.
                        </Text>
                      )}
                      <LazyLegacyButton
                        type="button"
                        variant="legacy-bare-ghost"
                        data-testid="settings-diagnostics-open-hooks"
                        onClick={onOpenHooks}
                      >
                        Open agent setup
                      </LazyLegacyButton>
                    </Stack>
                  </>
                )
              })()
            )}
          </HookPanel>

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
          <Button variant="legacy-ghost" onClick={onOpenLogsFolder}>
            Open folder
          </Button>
        </Row>
        {hostInfo && <DiagnosticsCopyRow hostInfo={hostInfo} agentHooks={agentHooks} />}
      </SettingsList>
    </>
  )
}
