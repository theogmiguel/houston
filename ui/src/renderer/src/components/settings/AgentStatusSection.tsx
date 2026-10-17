import { useEffect, useState } from 'react'
import type { AgentHookState } from '../../houston/generated/AgentHookState'
import type { AgentAccountIdentity } from '../../houston/generated/AgentAccountIdentity'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { AgentProfileState } from '../SettingsView'
import { AgentProfiles } from '../AgentProfiles'
import { accountSummary } from './cliAccountText'
import { CheckedStamp } from '../ui/CheckedStamp'
import { ICON_ROLE_CLS } from '../ui/Icon'
import { IconAgent, IconLoaderCircle, IconRefresh, IconZap } from '../icons'
import { AgentCliRow } from '../ui/AgentCliRow'
import { Button, Card, PageHeader, DialogBackdrop, DialogPanel, DialogTitle, DialogBody, DialogActions } from '../ui'
import { Caption } from '../ui/Caption'
import { Group, SettingsRow } from '../ui/settingsPrimitives'
import { type StatusIconState } from '../ui/StatusIcon'
import { Tooltip } from '../ui/Tooltip'
import { Text } from '../ui/Text'
import { PaneHeaderButton } from '../ui/PaneHeaderButton'
import { CenteredStatus, EmptyPanel, HookNotice, HookPath } from '../ui/SettingsStatus'
import { Switch } from '../ui/Switch'

export const HOOK_COPY: Record<string, { label: string; writes: string }> = {
  claude: {
    label: 'Claude Code',
    writes:
      'Adds lifecycle hooks to your Claude user settings and Houston account profiles. Claude reports status from any directory inside a Houston pane. Your own hooks are preserved; turning this off removes Houston’s entries.'
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
  },
  zcode: {
    label: 'ZCode',
    writes:
      'Adds one entry per lifecycle event to each ZCode settings file in `~/.zcode/cli/` — `setting.json` (read by the `zcode-app-cli` package) and `config.json` — creating `config.json` only when neither exists. Sets `hooks.enabled` (which also runs hooks of yours that were switched off) and lists Houston’s plugin for the pane tools. Turning this off removes only Houston’s entries and restores `hooks.enabled` once no channel’s entry remains.'
  }
}

export interface AgentStatusSectionProps {
  providers: AgentHookState[] | null
  onSet: (provider: AgentKind, enabled: boolean) => void
  onRefresh: () => void
  checkedAt?: number | null
  agentProfiles?: AgentProfileState | null
  agentAccounts?: AgentAccountIdentity[] | null
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
    <Switch size="status"
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

function AgentDetail({ state, pending, onSet }: { state: AgentHookState; pending: boolean; onSet: (provider: AgentKind, enabled: boolean) => void }): React.JSX.Element {
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

    </div>
  )
}

export function AgentStatusSection({
  providers,
  agentAccounts = null,
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
  const [selected, setSelected] = useState<AgentKind | null>(null)

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

  const detail = providers?.find((provider) => provider.provider === selected)
  return <div className="grid gap-[var(--space-6)]">
    <PageHeader heading="CLIs" description="The agent CLIs Houston can launch, whether they report status, and the accounts new panes use." actions={actions} />
    {providers === null ? <CenteredStatus testId="agent-status-loading" title="Checking agent status…" detail="Asking the daemon what is installed." /> : providers.length === 0 ? <EmptyPanel testId="agent-status-empty" title="No hookable CLIs" icon={IconZap}>The daemon reported no CLI it can wire. Panes will still run — they just show no Working / Idle / Needs input until a CLI that supports this is installed.</EmptyPanel> : <Card shape="card">
      {providers.map((state) => <ProviderRow key={state.provider} state={state} agentProfiles={agentProfiles} agentAccounts={agentAccounts ?? null} pending={pending[state.provider] !== undefined} onSet={handleSet} onOpen={() => setSelected(state.provider)} />)}
    </Card>}
    {agentProfiles ? <AgentProfiles accounts={agentAccounts ?? null} profiles={agentProfiles?.profiles ?? []} active={agentProfiles?.active ?? []} onUpsert={onAgentProfileUpsert ?? (() => {})} onDelete={onAgentProfileDelete ?? (() => {})} onSetActive={onAgentProfileSetActive ?? (() => {})} /> : <Text size="small" tone="muted">Reading accounts…</Text>}
    {detail && <DialogBackdrop onMouseDown={() => setSelected(null)}><DialogPanel size="wide" role="dialog" aria-modal="true" aria-labelledby="cli-detail-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') setSelected(null) }}><DialogTitle id="cli-detail-title">{copyFor(detail).label}</DialogTitle><DialogBody>{!detail.present && <Text as="p" size="small" tone="secondary">Install {copyFor(detail).label} using its official CLI instructions, then choose Check again. Houston looks for its executable on this computer's PATH.</Text>}<AgentDetail state={detail} pending={pending[detail.provider] !== undefined} onSet={handleSet} /></DialogBody><DialogActions variant="row"><Button variant="ghost" onClick={() => setSelected(null)}>Close</Button></DialogActions></DialogPanel></DialogBackdrop>}
  </div>
}

function ProviderRow({ state, agentProfiles, agentAccounts, pending, onSet, onOpen }: { state: AgentHookState; agentProfiles: AgentProfileState | null; agentAccounts: AgentAccountIdentity[] | null; pending: boolean; onSet: AgentStatusSectionProps['onSet']; onOpen: () => void }): React.JSX.Element {
  const mark = markFor(state)
  const profiles = agentProfiles?.profiles.filter((profile) => profile.agent === state.provider) ?? []
  const active = profiles.find((profile) => profile.id === agentProfiles?.active.find((entry) => entry.agent === state.provider)?.id)
  const accountLine = `${profiles.length} account${profiles.length === 1 ? '' : 's'}${active ? ` · ${active.name} is used for new panes` : ''}`
  const activeProfileId = agentProfiles?.active.find((entry) => entry.agent === state.provider)?.id ?? null
  const accountText = agentAccounts ? accountSummary(agentAccounts, state.provider, activeProfileId) : agentProfiles ? accountLine : 'Accounts not checked yet'
  const value = providerPresentation(state, mark, accountText)
  return <AgentCliRow provider={state.provider} name={copyFor(state).label} version={state.version} detail={value.detail} mark={mark} status={value.status} tone={value.tone} pending={pending} action={mark === 'absent' ? 'How to install' : mark === 'differs' ? 'Repair hooks' : undefined} onAction={mark === 'absent' ? onOpen : () => onSet(state.provider, true)} onOpen={onOpen} />
}

function providerPresentation(state: AgentHookState, mark: StatusIconState, accounts: string): { detail: string; status: string; tone: import('../ui/AgentSetupRow').SetupTone } {
  if (!state.present) return { detail: `${state.provider === 'cursor' ? 'cursor-agent' : state.provider} is not on PATH`, status: 'Not installed', tone: 'muted' }
  if (mark === 'differs') return { detail: 'Status will fall back to “unknown”', status: 'Hooks need repair', tone: 'warn' }
  if (mark === 'off') return { detail: 'Hooks are off · status is unknown', status: 'Hooks off', tone: 'muted' }
  if (state.trust === 'not_confirmed') return { detail: 'Accept the hook once in the Codex review screen', status: 'Hooks not confirmed', tone: 'warn' }
  return { detail: accounts, status: 'Reporting status', tone: 'ok' }
}
