import React, { useState } from 'react'
import { Tooltip } from './Tooltip'
import { Select } from './Select'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { AgentProfile } from '../houston/generated/AgentProfile'
import type { AgentProfileActive } from '../houston/generated/AgentProfileActive'

const BTN =
  'border-0 bg-transparent rounded-[var(--tr-radius-sm)] px-[10px] py-[5px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-40 disabled:cursor-default'
const PROFILE_BTN_PRIMARY =
  'rounded-[var(--tr-radius-sm)] border border-[var(--accent)] bg-[var(--accent-muted)] px-[10px] py-[5px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--accent)] hover:brightness-110 disabled:opacity-40 disabled:cursor-default'
const INPUT =
  'w-full bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2 disabled:opacity-50'

const AGENT_LABEL: Record<'claude' | 'codex', string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}
const AGENT_VAR: Record<'claude' | 'codex', string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME'
}

interface Props {
  profiles: AgentProfile[]
  active: AgentProfileActive[]
  onUpsert: (id: number | null, agent: AgentKind, name: string, configDir: string) => void
  onDelete: (id: number) => void
  onSetActive: (agent: AgentKind, id: number | null) => void
}

function AgentProfileCard({
  agent,
  profiles,
  activeId,
  onUpsert,
  onDelete,
  onSetActive
}: {
  agent: 'claude' | 'codex'
  profiles: AgentProfile[]
  activeId: number | null
  onUpsert: Props['onUpsert']
  onDelete: Props['onDelete']
  onSetActive: Props['onSetActive']
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const canAdd = name.trim().length > 0 && dir.trim().length > 0

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--content-bg)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--divider)] px-[14px] py-[9px]">
        <span className="[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">
          {AGENT_LABEL[agent]}
        </span>
        <span className="font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">{AGENT_VAR[agent]}</span>
      </div>

      <div className="px-[14px] py-2">
        {}
        <label className="mb-1 block [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">
          Spawned panes — active profile
        </label>
        <div className="mb-[6px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.45] text-[var(--text-muted)]">
          The account exported to panes Houston launches. If you switch accounts with a shell alias,
          keep this on default — the alias sets the variable itself.
        </div>
        <Select
          className="w-full"
          data-testid={`agent-profile-active-${agent}`}
          aria-label={`${AGENT_LABEL[agent]} — active profile`}
          value={activeId === null || activeId === undefined ? '' : String(activeId)}
          options={[
            { value: '', label: 'Default account (no override)' },
            ...profiles.map((p) => ({
              value: String(p.id),
              label: `${p.name} — ${p.config_dir}`
            }))
          ]}
          onChange={(v) => onSetActive(agent, v === '' ? null : Number(v))}
        />
      </div>

      <div className="border-t border-[var(--divider)] px-[14px] pb-[2px] pt-2">
        <div className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">
          Saved profiles
        </div>
      </div>

      {profiles.length > 0 && (
        <ul className="border-t border-[var(--divider)]">
          {profiles.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-2 border-b border-[var(--divider)] px-[14px] py-[7px] last:border-b-0"
            >
              <div className="min-w-0">
                <div className="truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]">{p.name}</div>
                <div className="truncate font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">
                  {p.config_dir}
                </div>
              </div>
              <Tooltip
                label={
                  p.id === activeId
                    ? 'Delete (this is the active profile — it will fall back to the default account)'
                    : 'Delete'
                }
              >
                <button type="button" className={BTN} onClick={() => onDelete(p.id)}>
                  Delete
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2 border-t border-[var(--divider)] px-[14px] py-[9px]">
        <div className="flex-1 flex flex-col gap-1">
          <label className="block [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">Name</label>
          <input
            className={INPUT}
            value={name}
            placeholder="work"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex-[2] flex flex-col gap-1">
          <label className="block [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">Directory</label>
          <input
            className={INPUT}
            value={dir}
            placeholder={agent === 'claude' ? '~/.claude-work' : '~/.codex-work'}
            onChange={(e) => setDir(e.target.value)}
          />
        </div>
        <button
          type="button"
          className={`btn ${PROFILE_BTN_PRIMARY}`}
          disabled={!canAdd}
          onClick={() => {
            onUpsert(null, agent, name.trim(), dir.trim())
            setName('')
            setDir('')
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

export function AgentProfiles({ profiles, active, onUpsert, onDelete, onSetActive }: Props): React.JSX.Element {
  const activeFor = (agent: 'claude' | 'codex'): number | null =>
    active.find((a) => a.agent === agent)?.id ?? null

  return (
    <div>
      <div className="mb-[10px] rounded-md border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-secondary)]">
        Switching applies only to the <strong>next</strong> terminal Houston opens for that CLI —
        sessions already running keep their account. Added or removed accounts apply at once,
        however the agent was started.
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <AgentProfileCard
          agent="claude"
          profiles={profiles.filter((p) => p.agent === 'claude')}
          activeId={activeFor('claude')}
          onUpsert={onUpsert}
          onDelete={onDelete}
          onSetActive={onSetActive}
        />
        <AgentProfileCard
          agent="codex"
          profiles={profiles.filter((p) => p.agent === 'codex')}
          activeId={activeFor('codex')}
          onUpsert={onUpsert}
          onDelete={onDelete}
          onSetActive={onSetActive}
        />
      </div>
    </div>
  )
}
