import { useState, type ReactNode } from 'react'
import type { Skill } from '../../env'
import type { AgentKind } from '../../houston/generated/AgentKind'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import type { SkillPushRecord } from '../../houston/generated/SkillPushRecord'
import { Button, Card, PageHeader, Segmented, Text, TextInput } from '../ui'
import { DataTable } from '../ui/DataTable'
import { Notice } from '../ui/Notice'
import { Tooltip } from '../ui/Tooltip'
import { Drawer } from '../ui/Drawer'
import { SettingsToolbar } from '../ui/SettingsToolbar'
import { SkillItemDistribution } from '../SkillDistribution'
import { copyAgentLabel, libraryCopies, librarySkillId, syncLibrarySkill, uniqueLibrarySkills } from './skillLibraryCopies'

type Push = (tool: AgentKind, skill: string) => void
interface LibraryProps {
  allSkills?: Skill[]; skills: Skill[]; search: string; onSearch: (search: string) => void; tools?: SkillToolState[] | null
  actions: ReactNode; onOpen: (skill: Skill) => void; detail: ReactNode; onClose: () => void; modalOpen: boolean
  onPush?: Push; onPushUndo?: Push; pushes?: SkillPushRecord[]; error?: ReactNode; children?: ReactNode
}
export function SkillsSettingsLibrary({ allSkills, skills, search, onSearch, tools, actions, onOpen, detail, onClose, modalOpen, onPush, onPushUndo, pushes, error, children }: LibraryProps): React.JSX.Element {
  const [scope, setScope] = useState<'all' | 'user' | 'project'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const unique = uniqueLibrarySkills(skills)
  const visible = unique.filter(skill => scope === 'all' || skill.source === scope)
  const toggle = (skill: Skill): void => {
    const id = librarySkillId(skill)
    setExpanded(expanded === id ? null : id)
    if (expanded === id) onClose()
    else onOpen(skill)
  }
  return <div data-testid="skills-library" className="grid gap-[var(--space-3)]">
    <PageHeader heading="Skills" count={uniqueLibrarySkills(allSkills ?? skills).length} description="Your reusable instructions, available across agents." actions={<div className="flex gap-[var(--space-2)]">{actions}</div>} />
    <SettingsToolbar><div className="min-w-0 flex-1"><TextInput role="searchbox" aria-label="Search skills" placeholder="Search skills" value={search} onChange={event => onSearch(event.target.value)} /></div><Segmented aria-label="Scope" value={scope} onChange={setScope} options={[{ value: 'all', label: 'All' }, { value: 'user', label: 'Yours' }, { value: 'project', label: 'This workspace' }]} /></SettingsToolbar>
    {!error && <MissingCopiesNotice skills={uniqueLibrarySkills(allSkills ?? skills)} tools={tools} onPush={onPush} />}
    {error ?? (visible.length ? <DataTable variant="dense" aria-label="Skills library" maxBodyHeight={900} rows={visible} getRowId={librarySkillId} onRowClick={toggle} expandedRowId={expanded} renderExpanded={skill => <div className="grid gap-[var(--space-3)]"><SkillCopyDetail skill={skill} tools={tools} onPush={onPush} onPushUndo={onPushUndo} pushes={pushes} />{!modalOpen && detail}</div>} columns={[
      { key: 'skill', header: 'Skill', width: '220px', render: skill => <span className="flex items-baseline gap-[var(--space-2)]"><Text mono size="small" className="truncate">{skill.invoke}</Text>{scope === 'all' && <Text size="small" tone="muted">{skill.source === 'project' ? 'This workspace' : 'You'}</Text>}</span> },
      { key: 'description', header: 'Description', render: skill => <Tooltip label={skill.description || 'No description provided.'}><Text as="div" size="small" tone="secondary" className="truncate">{skill.description || 'No description provided.'}</Text></Tooltip> },
      { key: 'copies', header: 'Copies', width: '90px', render: skill => <CopyCount skill={skill} tools={tools} /> }
    ]} /> : <Card padding="md"><Text size="small" tone="muted">No skills match this search and scope.</Text></Card>)}
    <Drawer open={modalOpen} heading="Skill" onClose={onClose}>{detail}</Drawer>
    {children}
  </div>
}
function CopyCount({ skill, tools }: Pick<LibraryProps, 'tools'> & { skill: Skill }): React.JSX.Element {
  const state = libraryCopies(skill, tools)
  return <Text size="small" tabular tone={state.conflict ? 'warn' : state.missing.length ? 'secondary' : 'muted'}>{state.conflict ? 'Review' : state.checked ? `${state.copies.length - state.missing.length}/${state.copies.length}` : 'Unchecked'}</Text>
}
function MissingCopiesNotice({ skills, tools, onPush }: Pick<LibraryProps, 'skills' | 'tools' | 'onPush'>): React.JSX.Element | null {
  const missing = skills.filter(skill => libraryCopies(skill, tools).missing.length > 0)
  const conflicts = skills.filter(skill => libraryCopies(skill, tools).conflict)
  if (!missing.length && !conflicts.length) return null
  const agents = [...new Set(missing.flatMap(skill => libraryCopies(skill, tools).missing.map(copy => copyAgentLabel(copy.tool.tool))))]
  const syncable = missing.some(skill => { const state = libraryCopies(skill, tools); return skill.agent === 'claude' && state.source && !state.conflict })
  return <Notice tone="warn" action={onPush && syncable ? { label: 'Sync all', onClick: () => missing.forEach(skill => syncLibrarySkill(skill, tools, onPush)) } : undefined}>
    <Text weight="semibold">{missing.length ? `${missing.length} ${missing.length === 1 ? 'skill is' : 'skills are'} missing copies` : 'Skill copies need review'}</Text><br />
    <Text size="small">{agents.length > 0 && `In ${agents.join(' or ')}. `}{conflicts.length > 0 && `${conflicts.length} ${conflicts.length === 1 ? 'skill has' : 'skills have'} differing copies; ${conflicts.length === 1 ? 'it is excluded from Sync all and needs review' : 'they are excluded from Sync all and need review'}.`}</Text>
  </Notice>
}
function SkillCopyDetail({ skill, tools, onPush, onPushUndo, pushes }: Pick<LibraryProps, 'tools' | 'onPush' | 'onPushUndo' | 'pushes'> & { skill: Skill }): React.JSX.Element {
  const state = libraryCopies(skill, tools)
  return <div className="grid gap-[var(--space-2)]">
    <DataTable aria-label={`Agent copies of ${skill.name}`} rows={state.copies} getRowId={copy => copy.tool.tool} columns={[
      { key: 'agent', header: 'Agent', render: copy => <Text size="small">{copyAgentLabel(copy.tool.tool)}</Text> },
      { key: 'status', header: 'Copy', render: copy => <Text size="small" tone={copy.status === 'Differs' ? 'warn' : copy.status === 'Missing' ? 'muted' : 'secondary'}>{copy.status}{copy.inherited && ' (reads Claude Code’s copy)'}</Text> }
    ]} />
    <Text size="small" tone="secondary">{state.conflict ? 'Copies differ. Compare instructions before choosing which copy to keep.' : state.source ? 'Sync uses Claude Code’s copy. Agents that read it directly do not need another copy.' : 'A Claude Code source copy is required to sync this skill.'}</Text>
    {skill.agent === 'claude' && onPush && state.source && !state.conflict && state.missing.length > 0 && <Button variant="secondary" size="sm" onClick={() => syncLibrarySkill(skill, tools, onPush)}>Sync this skill</Button>}
    {skill.agent === 'claude' && onPush && onPushUndo && tools && <SkillItemDistribution skillName={skill.name} tools={tools} pushes={pushes ?? []} onPush={onPush} onPushUndo={onPushUndo} />}
  </div>
}
