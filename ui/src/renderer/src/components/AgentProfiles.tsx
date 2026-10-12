import { useState } from 'react'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { AgentProfile } from '../houston/generated/AgentProfile'
import type { AgentProfileActive } from '../houston/generated/AgentProfileActive'
import { Button, Card, Chip, DialogActions, DialogBackdrop, DialogBody, DialogPanel, DialogTitle, Field, Text, TextInput } from './ui'

const LABEL = { claude: 'Claude Code', codex: 'Codex' }
const VARIABLE = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
type ProfileAgent = keyof typeof LABEL
interface Props {
  agents?: ProfileAgent[]
  profiles: AgentProfile[]
  active: AgentProfileActive[]
  onUpsert: (id: number | null, agent: AgentKind, name: string, configDir: string) => void
  onDelete: (id: number) => void
  onSetActive: (agent: AgentKind, id: number | null) => void
}
function ProfileEditor({ agent, profile, onSave, onDelete, onClose }: { agent: ProfileAgent; profile: AgentProfile | null; onSave: Props['onUpsert']; onDelete: Props['onDelete']; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(profile?.name ?? '')
  const [directory, setDirectory] = useState(profile?.config_dir ?? '')
  return <DialogBackdrop onMouseDown={onClose}><DialogPanel size="wide" role="dialog" aria-modal="true" aria-labelledby="profile-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}><form onSubmit={(event) => { event.preventDefault(); if (!name.trim() || !directory.trim()) return; onSave(profile?.id ?? null, agent, name.trim(), directory.trim()); onClose() }}>
    <DialogTitle id="profile-title">{profile ? 'Rename account' : 'Add account'}</DialogTitle><DialogBody><Text size="small" tone="secondary">New {LABEL[agent]} panes use {VARIABLE[agent]} for this account.</Text><Field label="Name"><TextInput autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Directory"><TextInput value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder={agent === 'claude' ? '~/.claude-work' : '~/.codex-work'} /></Field></DialogBody>
    <DialogActions variant="row">{profile && <Button type="button" variant="danger" onClick={() => { onDelete(profile.id); onClose() }}>Delete</Button>}<Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!name.trim() || !directory.trim()}>Save</Button></DialogActions>
  </form></DialogPanel></DialogBackdrop>
}
function AccountList({ agent, profiles, activeId, onUpsert, onDelete, onSetActive }: { agent: ProfileAgent; profiles: AgentProfile[]; activeId: number | null } & Pick<Props, 'onUpsert' | 'onDelete' | 'onSetActive'>): React.JSX.Element {
  const [editor, setEditor] = useState<AgentProfile | 'new' | null>(null)
  return <section data-settings-row-name={`${LABEL[agent]} accounts`} className="grid gap-[var(--space-3)]">
    <header className="flex items-center justify-between gap-[var(--space-3)]"><Text as="h2" size="ui" weight="medium" flush>{LABEL[agent]} accounts</Text><Button variant="ghost" onClick={() => setEditor('new')}>+ Add account</Button></header>
    <Card shape="card">
      {profiles.map((profile) => <Card.Row key={profile.id} heading={<span className="flex items-center gap-[var(--space-2)]"><Text>{profile.name}</Text>{profile.id === activeId && <Chip variant="state" label="New panes" />}</span>} meta={<Text mono>{profile.config_dir}</Text>} action={<span className="flex items-center gap-[var(--space-2)]"><Button variant="ghost" onClick={() => setEditor(profile)}>Rename</Button>{profile.id !== activeId && <Button variant="ghost" data-testid={`agent-profile-use-${profile.id}`} onClick={() => onSetActive(agent, profile.id)}>Use for new panes</Button>}</span>} />)}
      <Card.Row heading={<span className="flex items-center gap-[var(--space-2)]">Default account{activeId === null && <Chip variant="state" label="New panes" />}</span>} meta={<Text mono>{VARIABLE[agent]} is not overridden</Text>} action={activeId !== null && <Button variant="ghost" data-testid={`agent-profile-default-${agent}`} onClick={() => onSetActive(agent, null)}>Use for new panes</Button>} />
    </Card>
    <Text as="p" size="small" tone="muted" flush>Switching applies to panes you open next. Running panes keep their account.</Text>
    {editor && <ProfileEditor agent={agent} profile={editor === 'new' ? null : editor} onSave={onUpsert} onDelete={onDelete} onClose={() => setEditor(null)} />}
  </section>
}
export function AgentProfiles({ profiles, active, onUpsert, onDelete, onSetActive, agents = ['claude', 'codex'] }: Props): React.JSX.Element {
  return <div className="grid gap-[var(--space-6)]">{agents.map((agent) => <AccountList key={agent} agent={agent} profiles={profiles.filter((profile) => profile.agent === agent)} activeId={active.find((entry) => entry.agent === agent)?.id ?? null} onUpsert={onUpsert} onDelete={onDelete} onSetActive={onSetActive} />)}</div>
}
