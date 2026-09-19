import { useEffect, useState } from 'react'
import type { AgentHookState } from '../../houston/generated/AgentHookState'
import type { AgentKind } from '../../houston/generated/AgentKind'
import { CheckedStamp } from '../CheckedStamp'
import { Icon, ICON_ROLE_CLS } from '../Icon'
import { IconAgent, IconLoaderCircle, IconRefresh, IconZap } from '../icons'
import { ListDetail, type ListDetailItem } from '../nav/ListDetail'
import { CHROME_BUTTON, NavDetailState, NavEmpty, NavSwitch } from '../nav/navChrome'
import { Group, SectionHead, SettingsRow } from '../settingsPrimitives'
import { StatusIcon, type StatusIconState } from '../StatusIcon'
import { Tooltip } from '../Tooltip'

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
    <NavSwitch
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
  return (
    <span className="font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)] tabular-nums">
      {version ?? 'Unknown'}
    </span>
  )
}

function AgentDetail({
  state,
  pending,
  onSet
}: {
  state: AgentHookState
  pending: boolean
  onSet: (provider: AgentKind, enabled: boolean) => void
}): React.JSX.Element {
  const copy = copyFor(state)
  const scope = state.scope === 'workspace' ? 'Every workspace Houston opens' : 'This machine'
  const mismatch = state.enabled && !state.installed
  return (
    <div
      data-testid="agent-status-detail"
      data-provider={state.provider}
      data-status={markFor(state)}
      className="flex flex-col gap-[var(--space-4)]"
    >
      {}
      <header className="flex items-center gap-[var(--space-3)]">
        <span aria-hidden="true" className="flex-none flex items-center">
          <IconAgent agent={state.provider} className={ICON_ROLE_CLS.subhead} />
        </span>
        <div className="min-w-0 flex-1 flex items-baseline gap-[var(--space-2)]">
          <strong className="truncate text-[length:var(--tr-text-subhead-size)] font-[var(--tr-text-subhead-weight)] text-[var(--text-primary)]">
            {copy.label}
          </strong>
          <VersionText version={state.version} />
        </div>
        {switchFor(state, copy.label, pending, onSet, 'agent-status-switch')}
      </header>

      <Group heading="Hooks">
        <SettingsRow title="Scope">
          <span className="[font-size:var(--tr-text-small-size)] text-[var(--text-secondary)]">{scope}</span>
        </SettingsRow>
        <SettingsRow
          title="What Houston writes"
          desc={
            <div className="whitespace-normal">
              <span>{copy.writes}</span>
              <div className="pt-[var(--space-1)] font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">
                {state.path}
              </div>
              {state.error && (
                <div
                  data-testid="agent-status-error"
                  className="pt-[var(--space-1-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--danger)]"
                >
                  {state.error}
                </div>
              )}
              {!state.error && mismatch && (
                <div
                  data-testid="agent-status-mismatch"
                  className="pt-[var(--space-1-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--warning)]"
                >
                  On, but nothing is installed right now — the file may have been edited outside
                  Houston.
                </div>
              )}
              {state.provider === 'codex' && state.trust === 'not_confirmed' && (
                <div
                  data-testid="agent-status-codex-trust"
                  className="pt-[var(--space-1-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--warning)]"
                >
                  Hooks installed, not confirmed: Codex runs a hook only after you accept it once
                  in its own review screen — open any Codex pane.
                </div>
              )}
            </div>
          }
        />
      </Group>

      <Group heading="On this machine">
        <SettingsRow title="Binary">
          <span className="[font-size:var(--tr-text-small-size)] text-[var(--text-secondary)]">
            {state.present ? 'Found on PATH' : 'Not found'}
          </span>
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
  onSet,
  onRefresh,
  checkedAt = null
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
      <button
        type="button"
        aria-label="Check again"
        className={CHROME_BUTTON}
        onClick={handleRefresh}
        disabled={checking || providers === null}
        data-testid="agent-status-check-again"
      >
        <Icon
          glyph={checking ? IconLoaderCircle : IconRefresh}
          role="small"
          className={checking ? 'animate-spin' : undefined}
        />
        </button>
      </Tooltip>
    </>
  )

  const items: ListDetailItem[] = (providers ?? []).map((state) => {
    const copy = copyFor(state)
    return {
      id: state.provider,
      title: (
        <span
          data-testid="agent-status-row"
          data-provider={state.provider}
          data-status={markFor(state)}
          className={`flex items-baseline gap-[var(--space-2)] ${
            state.present ? '' : 'text-[var(--text-secondary)]'
          }`}
        >
          <span className="truncate">{copy.label}</span>
          {state.version && (
            <span className="flex-none font-mono [font-size:var(--tr-text-small-size)] text-[var(--text-faint)] tabular-nums">
              {state.version}
            </span>
          )}
        </span>
      ),
      sub: stateLine(state),
      right: (
        <span className="flex items-center gap-[var(--space-2)]">
          <StatusIcon state={markFor(state)} />
          {switchFor(
            state,
            copy.label,
            pending[state.provider] !== undefined,
            handleSet,
            'agent-status-row-switch'
          )}
        </span>
      )
    }
  })

  return (
    <>
      <SectionHead
        title="Agent setup"
        lede="Show when agents are working or need input. Houston learns this from a small hook it installs in each CLI's own config — never by reading the terminal. Every switch here edits that CLI's own file, and turning one off removes exactly what Houston wrote."
        actions={actions}
      />
      {providers === null ? (
        <NavDetailState
          testId="agent-status-loading"
          title="Checking agent status…"
          detail="Asking the daemon what is installed."
        />
      ) : providers.length === 0 ? (
        <NavEmpty
          testId="agent-status-empty"
          title="No hookable CLIs"
          icon={<Icon glyph={IconZap} role="display" />}
        >
          The daemon reported no CLI it can wire. Panes will still run — they just show no
          Working / Idle / Needs input until a CLI that supports this is installed.
        </NavEmpty>
      ) : (
        <ListDetail
          items={items}
          backLabel="Agent setup"
          listHead={
            <span className="px-[2px] py-[4px] block [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] text-[var(--text-faint)]">
              Agent CLIs · <span className="tabular-nums">{items.length}</span>
            </span>
          }
          renderDetail={(item) => {
            const state = providers.find((p) => p.provider === item?.id)
            if (!state) {
              return (
                <div className="flex-1 flex items-center justify-center text-center [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">
                  Nothing selected. Each CLI here carries the file Houston writes into and what
                  is installed on this machine.
                </div>
              )
            }
            return (
              <AgentDetail
                state={state}
                pending={pending[state.provider] !== undefined}
                onSet={handleSet}
              />
            )
          }}
        />
      )}
    </>
  )
}
