import { useEffect, useState } from 'react'
import type { AgentHookState } from '../../houston/generated/AgentHookState'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { AgentProfileState } from '../SettingsView'
import { AgentProfiles } from '../AgentProfiles'
import { CheckedStamp } from '../ui/CheckedStamp'
import { ICON_ROLE_CLS } from '../ui/Icon'
import { IconAgent, IconLoaderCircle, IconRefresh, IconZap } from '../icons'
import { ListDetail, type ListDetailItem } from '../nav/ListDetail'
import { Caption } from '../ui/Caption'
import { Group, SectionHead, SettingsRow } from '../ui/settingsPrimitives'
import { StatusIcon, type StatusIconState } from '../ui/StatusIcon'
import { Tooltip } from '../ui/Tooltip'
import { Text } from '../ui/Text'
import { PaneHeaderButton } from '../ui/PaneHeaderButton'
import { CenteredStatus, CompactSwitch, EmptyPanel, HookNotice, HookPath } from '../ui/SettingsStatus'

export const HOOK_COPY: Record<string, { label: string; writes: string }> = {
  claude: {
    label: 'Claude Code',
    writes:
      'Adds four hook entries to each workspace Houston opens. Your own hooks are untouched, and turning this off removes exactly what Houston added.'
  },
  codex: {
    label: 'Codex',
    writes:
      'Writes `~/.codex/hooks.json`, one entry per lifecycle event. An existing `notify` line in `config.toml` is parked — commented out, and restored when you turn this off — and a multi-line one is refused rather than rewritten.'
  },
  opencode: {
    label: 'OpenCode',
    writes:
      'Drops a small plugin file Houston owns. If a file is already there and Houston did not write it, the install refuses instead of overwriting it.'
  },
  cursor: {
    label: 'Cursor',
    writes:
      'Adds one entry to each of your `sessionStart`, `beforeSubmitPrompt` and `stop` hooks. Your other entries stay where they are.'
  },
  grok: {
    label: 'Grok',
    writes:
      'Writes its own hooks file in `~/.grok/hooks/`, with one entry per lifecycle event. Any entries of yours in that file stay, and turning this off removes only Houston’s — deleting the file once nothing is left in it.'
  }
}

export interface AgentStatusSectionProps {
  providers: AgentHookState[] | null
  onSet: (provider: AgentKind, enabled: boolean) => void
  onRefresh: () => void
  checkedAt?: number | null
  agentProfiles?: AgentProfileState | null
  onAgentProfileUpsert?: (id: number | null, agent: AgentKind, name: string, configDir: string) => void
  onAgentProfileDelete?: (id: number) => void
  onAgentProfileSetActive?: (agent: AgentKind, id: number | null) => void
}

function copyFor(state: AgentHookState): { label: string; writes: string } {
  return (
    HOOK_COPY[state.provider] ?? {
      label: state.provider,
      writes: 'Installs a hook for this CLI.'
    }
  )
}

export function markFor(state: AgentHookState): StatusIconState {
  if (!state.present) return 'absent'
  if (state.error || (state.enabled && !state.installed)) return 'differs'
  return state.installed ? 'ok' : 'off'
}

export function stateLine(state: AgentHookState): string {
  const mark = markFor(state)
  if (mark === 'absent') return 'Not found on PATH'
  if (mark === 'differs') return 'Installed · hooks need attention'
  return mark === 'ok' ? 'Installed · hooks on' : 'Installed · hooks off'
}

function switchFor(
  state: AgentHookState,
  label: string,
  pending: boolean,
  onSet: (provider: AgentKind, enabled: boolean) => void,
  testId: string
): React.JSX.Element {
  return (
    <CompactSwitch
      on={state.enabled}
      disabled={pending || !state.present}
      label={
        state.enabled
          ? `Stop calling Houston from ${label}`
          : `Let ${label} call Houston when a turn ends`
      }
      onChange={(on) => onSet(state.provider, on)}
      testId={testId}
    />
  )
}

function VersionText({ version }: { version: string | null }): React.JSX.Element {
  return <Caption tone="faint" variant="code">{version ?? 'Unknown'}</Caption>
}

function AgentDetail({
  state,
  pending,
  onSet,
  agentProfiles,
  onAgentProfileUpsert,
  onAgentProfileDelete,
  onAgentProfileSetActive
}: {
  state: AgentHookState
  pending: boolean
  onSet: (provider: AgentKind, enabled: boolean) => void
  agentProfiles: AgentProfileState | null
  onAgentProfileUpsert?: AgentStatusSectionProps['onAgentProfileUpsert']
  onAgentProfileDelete?: AgentStatusSectionProps['onAgentProfileDelete']
  onAgentProfileSetActive?: AgentStatusSectionProps['onAgentProfileSetActive']
}): React.JSX.Element {
  const copy = copyFor(state)
  const scope = state.scope === 'workspace' ? 'Every workspace Houston opens' : 'This machine'
  const mismatch = state.enabled && !state.installed
  return (
    <div
      data-testid="agent-status-detail"
      data-provider={state.provider}
      data-status={markFor(state)}
      className="grid gap-[var(--space-4)]"
    >
      {}
      <header className="flex items-center gap-[var(--space-3)]">
        <span aria-hidden="true" className="flex-none flex items-center">
          <IconAgent agent={state.provider} className={ICON_ROLE_CLS.subhead} />
        </span>
        <div className="min-w-0 flex-1 flex items-baseline gap-[var(--space-2)]">
          <Text as="strong" className="truncate" size="subhead" weight="subhead" tone="primary">
            {copy.label}
          </Text>
          <VersionText version={state.version} />
        </div>
        {switchFor(state, copy.label, pending, onSet, 'agent-status-switch')}
      </header>

      <Group heading="Hooks">
        <SettingsRow title="Scope">
          <Text size="small" tone="secondary">{scope}</Text>
        </SettingsRow>
        <SettingsRow
          title="What Houston writes"
          desc={
            <div>
              <span>{copy.writes}</span>
              <HookPath>
                {state.path}
              </HookPath>
              {state.error && (
                <HookNotice testId="agent-status-error" tone="danger">{state.error}</HookNotice>
              )}
              {!state.error && mismatch && (
                <HookNotice testId="agent-status-mismatch" tone="warning">On, but nothing is installed right now — the file may have been edited outside
                  Houston.
                </HookNotice>
              )}
              {state.provider === 'codex' && state.trust === 'not_confirmed' && (
                <HookNotice testId="agent-status-codex-trust" tone="warning">Hooks installed, not confirmed: Codex runs a hook only after you accept it once
                  in its own review screen — open any Codex pane.
                </HookNotice>
              )}
            </div>
          }
        />
      </Group>

      <Group heading="On this machine">
        <SettingsRow title="Binary">
          <Text size="small" tone="secondary">
            {state.present ? 'Found on PATH' : 'Not found'}
          </Text>
        </SettingsRow>
        <SettingsRow title="Version">
          <VersionText version={state.version} />
        </SettingsRow>
      </Group>
      {(state.provider === 'claude' || state.provider === 'codex') && (
        <Group heading="Accounts">
          <AgentProfiles
            agents={[state.provider]}
            profiles={agentProfiles?.profiles ?? []}
            active={agentProfiles?.active ?? []}
            onUpsert={onAgentProfileUpsert ?? (() => {})}
            onDelete={onAgentProfileDelete ?? (() => {})}
            onSetActive={onAgentProfileSetActive ?? (() => {})}
          />
        </Group>
      )}
    </div>
  )
}

export function AgentStatusSection({
  providers,
  onSet,
  onRefresh,
  checkedAt = null,
  agentProfiles = null,
  onAgentProfileUpsert,
  onAgentProfileDelete,
  onAgentProfileSetActive
}: AgentStatusSectionProps): React.JSX.Element {
  const [pending, setPending] = useState<Partial<Record<AgentKind, boolean>>>({})
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (providers === null) return
    setChecking(false)
    setPending((prev) => {
      if (Object.keys(prev).length === 0) return prev
      let changed = false
      const next = { ...prev }
      for (const provider of Object.keys(prev) as AgentKind[]) {
        const state = providers.find((p) => p.provider === provider)
        const target = prev[provider]
        // Settled needs `installed` to match the target too, not just `enabled` —
        // otherwise an unrelated `providers` refresh clears the pending switch
        // before the write it was waiting on actually landed.
        const settled =
          !state || state.error || (state.enabled === target && (!target || state.installed))
        if (settled) {
          delete next[provider]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [providers])

  const handleSet = (provider: AgentKind, enabled: boolean): void => {
    setPending((prev) => ({ ...prev, [provider]: enabled }))
    onSet(provider, enabled)
  }

  const handleRefresh = (): void => {
    setChecking(true)
    onRefresh()
  }

  const actions = (
    <>
      <CheckedStamp at={checkedAt} />
      <Tooltip label="Look again for each CLI and re-read its hooks">
      <PaneHeaderButton
        aria-label="Check again"
        onClick={handleRefresh}
        disabled={checking || providers === null}
        data-testid="agent-status-check-again"
        icon={checking ? IconLoaderCircle : IconRefresh}
        iconRole="small"
        size="mini"
        tone="secondary"
        spinning={checking}
      />
      </Tooltip>
    </>
  )

  const items: ListDetailItem[] = (providers ?? []).map((state) => {
    const copy = copyFor(state)
    const accountCount = agentProfiles?.profiles.filter((profile) => profile.agent === state.provider).length ?? 0
    const subtitle = [
      state.version ?? 'Unknown',
      !state.present ? 'Not found on PATH' : state.error || (state.enabled && !state.installed)
        ? 'Hooks need attention' : state.installed ? 'Hooks on' : 'Hooks off',
      accountCount > 0 ? `${accountCount} account${accountCount === 1 ? '' : 's'}` : null
    ].filter(Boolean).join(' · ')
    return {
      id: state.provider,
      title: (
        <Text
          as="div"
          data-testid="agent-status-row"
          data-settings-row-name={copy.label}
          data-provider={state.provider}
          data-status={markFor(state)}
          className="grid min-w-0 items-start"
          tone={state.present ? undefined : 'secondary'}
        >
          <Text className="truncate" size="ui" weight="medium">{copy.label}</Text>
          <Text className="truncate" size="small" weight="small" tone="muted">{subtitle}</Text>
        </Text>
      ),
      right: <StatusIcon state={markFor(state)} />
    }
  })

  return (
    <>
      <SectionHead title="Agent CLIs" actions={actions} />
      {providers === null ? (
        <CenteredStatus
          testId="agent-status-loading"
          title="Checking agent status…"
          detail="Asking the daemon what is installed."
        />
      ) : providers.length === 0 ? (
        <EmptyPanel
          testId="agent-status-empty"
          title="No hookable CLIs"
          icon={IconZap}
        >
          The daemon reported no CLI it can wire. Panes will still run — they just show no
          Working / Idle / Needs input until a CLI that supports this is installed.
        </EmptyPanel>
      ) : (
        <ListDetail
          items={items}
          backLabel="Agent CLIs"
          renderDetail={(item) => {
            const state = providers.find((p) => p.provider === item?.id)
            if (!state) {
              return (
                <Text as="div" className="flex-1 flex items-center justify-center" center size="small" tone="faint">
                  Nothing selected. Each CLI here carries the file Houston writes into and what
                  is installed on this machine.
                </Text>
              )
            }
            return (
              <AgentDetail
                state={state}
                pending={pending[state.provider] !== undefined}
                onSet={handleSet}
                agentProfiles={agentProfiles}
                onAgentProfileUpsert={onAgentProfileUpsert}
                onAgentProfileDelete={onAgentProfileDelete}
                onAgentProfileSetActive={onAgentProfileSetActive}
              />
            )
          }}
        />
      )}
    </>
  )
}
