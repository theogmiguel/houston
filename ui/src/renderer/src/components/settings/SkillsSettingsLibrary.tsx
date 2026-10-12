import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Skill } from '../../env'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import { buildSkillRows } from '../../houston/skillRows'
import { Card, PageHeader, Segmented, Text, TextInput } from '../ui'
import { AgentSetupRow } from '../ui/AgentSetupRow'
import { ProviderGlyphTile } from '../ui/AgentCliRow'
import { SettingsToolbar } from '../ui/SettingsToolbar'
import { Drawer } from '../ui/Drawer'

function copyStatus(skill: Skill, tools: SkillToolState[] | null | undefined): { label: string; tone: 'warn' | 'ok' | 'muted' } {
  if (!tools) return { label: 'Copies not checked', tone: 'muted' }
  const row = buildSkillRows(tools).find((item) => item.name === skill.name)
  if (!row) return { label: 'No reported copies', tone: 'muted' }
  if (row.claude && row.byTool.codex && row.byTool.codex.digest !== row.claude.digest) return { label: 'Codex copy differs', tone: 'warn' }
  if (row.hasDrift) return { label: 'Copies differ', tone: 'warn' }
  const present = tools.filter((tool) => tool.detected)
  const all = present.length > 0 && present.every((tool) => row.byTool[tool.tool] || (tool.inherits_claude && row.claude))
  return { label: all ? 'In every agent' : 'Some copies are missing', tone: all ? 'ok' : 'warn' }
}
export function SkillsSettingsLibrary({ skills, search, onSearch, tools, actions, onOpen, detail, onClose, modalOpen, error, children }: { skills: Skill[]; search: string; onSearch: (search: string) => void; tools?: SkillToolState[] | null; actions: ReactNode; onOpen: (skill: Skill) => void; detail: ReactNode; onClose: () => void; modalOpen: boolean; error?: ReactNode; children?: ReactNode }): React.JSX.Element {
  const [scope, setScope] = useState<'all' | 'user' | 'project'>('all')
  const unique = new Map<string, Skill>()
  for (const skill of skills) {
    const key = `${skill.source}:${skill.name}`
    if (!unique.has(key) || skill.agent === 'claude') unique.set(key, skill)
  }
  const visible = [...unique.values()].filter((skill) => scope === 'all' || skill.source === scope)
  return <div data-testid="skills-library" className="grid gap-[var(--space-3)]">
    <PageHeader heading="Skills" description="One copy of each skill, synced into every agent that reads skills from its own folder." />
    <SettingsToolbar actions={actions}><TextInput role="searchbox" aria-label="Search skills" placeholder="Search skills" value={search} onChange={(event) => onSearch(event.target.value)} /><Segmented aria-label="Scope" value={scope} onChange={setScope} options={[{ value: 'all', label: 'All' }, { value: 'user', label: 'Yours' }, { value: 'project', label: 'This workspace' }]} /></SettingsToolbar>
    {error ?? (visible.length ? <Card shape="card">{visible.map((skill) => { const status = copyStatus(skill, tools); return <AgentSetupRow key={`${skill.source}:${skill.name}`} heading={<span className="flex items-baseline gap-[var(--space-2)]"><Text mono>{skill.invoke}</Text><Text size="small" tone="muted">{skill.source === 'project' ? 'This workspace' : 'You'}</Text></span>} detail={skill.description} tone={status.tone} status={status.label} chevron={false} beforeStatus={<SkillMarks skill={skill} tools={tools} />} onClick={() => onOpen(skill)} /> })}</Card> : <Card padding="md"><Text size="small" tone="muted">No skills match this search and scope.</Text></Card>)}
    <Drawer open={modalOpen} heading="Skill" onClose={onClose}>{detail}</Drawer>
    {children}
  </div>
}

function SkillMarks({ skill, tools }: { skill: Skill; tools?: SkillToolState[] | null }): React.JSX.Element {
  const row = buildSkillRows(tools ?? []).find((item) => item.name === skill.name)
  return <span className="flex items-center gap-[var(--space-1)]">{(tools ?? []).filter((tool) => tool.detected).map((tool) => {
    const entry = row?.byTool[tool.tool]
    const inherited = tool.inherits_claude && row?.claude
    const differs = row?.claude && entry && entry.digest !== row.claude.digest
    return <ProviderGlyphTile key={tool.tool} agent={tool.tool} state={differs ? 'differs' : entry || inherited ? 'on' : 'off'} />
  })}</span>
}
