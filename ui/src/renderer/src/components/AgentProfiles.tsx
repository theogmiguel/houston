import React, { useState } from 'react'
import { Tooltip } from './ui/Tooltip'
import { Select } from './ui/Select'
import { Button } from './ui/Button'
import { ProfileActiveSection, ProfileDescription, ProfileFieldLabel, ProfileFormField, ProfileFormRow, ProfileHeader, ProfileName, ProfileNotice, ProfilePanel, ProfilePath, ProfileSavedHeading, ProfileSavedList, ProfileSavedRow, ProfileValue } from './ui/ProfilePanel'
import { Text } from './ui/Text'
import { TextInput } from './ui/TextInput'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { AgentProfile } from '../houston/generated/AgentProfile'
import type { AgentProfileActive } from '../houston/generated/AgentProfileActive'

const AGENT_LABEL: Record<'claude' | 'codex', string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}
const AGENT_VAR: Record<'claude' | 'codex', string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME'
}

interface Props {
  agents?: Array<'claude' | 'codex'>
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
    <ProfilePanel>
      <ProfileHeader>
        <Text size="ui" weight="ui" tone="primary">
          {AGENT_LABEL[agent]}
        </Text>
        <ProfileValue>{AGENT_VAR[agent]}</ProfileValue>
      </ProfileHeader>

      <ProfileActiveSection data-settings-row-name="Active profile">
        {}
        <div className="grid gap-[var(--space-1)]">
          <ProfileFieldLabel>
            Spawned panes — active profile
          </ProfileFieldLabel>
          <ProfileDescription>
            The account exported to panes Houston launches. If you switch accounts with a shell alias,
            keep this on default — the alias sets the variable itself.
          </ProfileDescription>
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
      </ProfileActiveSection>

      <ProfileSavedHeading data-settings-row-name="Saved profiles">
        <Text size="label" weight="label" tone="faint" caps>
          Saved profiles
        </Text>
      </ProfileSavedHeading>

      {profiles.length > 0 && (
        <ProfileSavedList>
          {profiles.map((p) => (
            <ProfileSavedRow key={p.id}>
              <div className="min-w-0">
                <ProfileName>{p.name}</ProfileName>
                <ProfilePath>
                  {p.config_dir}
                </ProfilePath>
              </div>
              <Tooltip
                label={
                  p.id === activeId
                    ? 'Delete (this is the active profile — it will fall back to the default account)'
                    : 'Delete'
                }
              >
                <Button variant="ghost" size="sm" onClick={() => onDelete(p.id)}>
                  Delete
                </Button>
              </Tooltip>
            </ProfileSavedRow>
          ))}
        </ProfileSavedList>
      )}

      <ProfileFormRow data-settings-row-name="Add profile">
        <ProfileFormField>
          <ProfileFieldLabel variant="input">Name</ProfileFieldLabel>
          <TextInput
            variant="compact"
            value={name}
            placeholder="work"
            onChange={(e) => setName(e.target.value)}
          />
        </ProfileFormField>
        <ProfileFormField grow="two">
          <ProfileFieldLabel variant="input">Directory</ProfileFieldLabel>
          <TextInput
            variant="compact"
            value={dir}
            placeholder={agent === 'claude' ? '~/.claude-work' : '~/.codex-work'}
            onChange={(e) => setDir(e.target.value)}
          />
        </ProfileFormField>
        <Button
          variant="accent-soft"
          disabled={!canAdd}
          onClick={() => {
            onUpsert(null, agent, name.trim(), dir.trim())
            setName('')
            setDir('')
          }}
        >
          Add
        </Button>
      </ProfileFormRow>
    </ProfilePanel>
  )
}

export function AgentProfiles({ profiles, active, onUpsert, onDelete, onSetActive, agents = ['claude', 'codex'] }: Props): React.JSX.Element {
  const activeFor = (agent: 'claude' | 'codex'): number | null =>
    active.find((a) => a.agent === agent)?.id ?? null

  return (
    <div className="grid gap-[var(--space-2-5)]">
      <ProfileNotice>
        Switching applies only to the <strong>next</strong> terminal Houston opens for that CLI —
        sessions already running keep their account. Added or removed accounts apply at once,
        however the agent was started.
      </ProfileNotice>
      <div className="grid gap-[var(--space-3)] md:grid-cols-2">
        {agents.includes('claude') && <AgentProfileCard
          agent="claude"
          profiles={profiles.filter((p) => p.agent === 'claude')}
          activeId={activeFor('claude')}
          onUpsert={onUpsert}
          onDelete={onDelete}
          onSetActive={onSetActive}
        />}
        {agents.includes('codex') && <AgentProfileCard
          agent="codex"
          profiles={profiles.filter((p) => p.agent === 'codex')}
          activeId={activeFor('codex')}
          onUpsert={onUpsert}
          onDelete={onDelete}
          onSetActive={onSetActive}
        />}
      </div>
    </div>
  )
}
