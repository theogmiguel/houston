import { useState } from 'react'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { SkillToolState } from '../houston/generated/SkillToolState'
import type { SkillPushRecord } from '../houston/generated/SkillPushRecord'
import { buildSkillRows, needsPush, skillCellFor, type SkillRow } from '../houston/skillRows'
import { readFile } from '../houston/bridge'
import { CodePane } from './ui/Block'
import { Button } from './ui/Button'
import { DataTable } from './ui/DataTable'
import { PanelColumns } from './ui/PanelControls'
import { Text } from './ui/Text'
import { SettingsToolbar } from './ui/SettingsToolbar'
import { copyAgentLabel } from './settings/skillLibraryCopies'

type Push = (tool: AgentKind, skill: string) => void
interface CopyTableProps {
  skillName: string
  row?: SkillRow
  tools: SkillToolState[]
  pushes?: SkillPushRecord[]
  onPush?: Push
  onPushUndo?: Push
}
const CELL_STATUS = { same: 'Synced', differs: 'Differs', inherited: "Reads Claude's folder", missing: 'Missing' }

export function SkillCopyTable({ skillName, row, tools, pushes = [], onPush, onPushUndo }: CopyTableProps): React.JSX.Element {
  const [diff, setDiff] = useState<{ tool: AgentKind; content?: { claude: string; other: string }; error?: string } | null>(null)
  const openDiff = (tool: SkillToolState): void => {
    const entry = row?.byTool[tool.tool]
    if (!entry || !row?.claude) return
    setDiff({ tool: tool.tool })
    Promise.all([readFile(row.claude.path), readFile(entry.path)])
      .then(([claude, other]) => setDiff(current => current?.tool === tool.tool ? { tool: tool.tool, content: { claude, other } } : current))
      .catch((error: Error) => setDiff(current => current?.tool === tool.tool ? { tool: tool.tool, error: error.message } : current))
  }
  return <div data-testid="skill-item-distribution" className="min-w-0 grid gap-[var(--space-2)]">
    <DataTable variant="dense" maxBodyHeight={900} aria-label={`Agent copies of ${skillName}`} rows={tools} getRowId={tool => tool.tool} columns={[
      { key: 'agent', header: 'Agent', width: '18%', render: tool => <Text size="small">{copyAgentLabel(tool.tool)}</Text> },
      { key: 'status', header: 'Status', width: '25%', render: tool => <CopyStatus row={row} tool={tool} /> },
      { key: 'actions', header: 'Actions', render: tool => <CopyActions skillName={skillName} row={row} tool={tool} pushed={pushes.some(push => push.tool === tool.tool && push.skill === skillName)} onPush={onPush} onPushUndo={onPushUndo} onDiff={openDiff} /> }
    ]} />
    {diff && <CopyDifference diff={diff} onClose={() => setDiff(null)} />}
  </div>
}
function CopyStatus({ row, tool }: { row?: SkillRow; tool: SkillToolState }): React.JSX.Element {
  const cell = row ? skillCellFor(row, tool) : { kind: 'missing' as const }
  return <Text size="small" tone={cell.kind === 'differs' ? 'warn' : 'secondary'}>{CELL_STATUS[cell.kind]}</Text>
}
function CopyActions({ skillName, row, tool, pushed, onPush, onPushUndo, onDiff }: Omit<CopyTableProps, 'tools' | 'pushes'> & { tool: SkillToolState; pushed: boolean; onDiff: (tool: SkillToolState) => void }): React.JSX.Element {
  const cell = row ? skillCellFor(row, tool) : { kind: 'missing' as const }
  const pushable = row && !tool.error && needsPush(row, tool) && cell.kind !== 'inherited'
  return <SettingsToolbar>
    {cell.kind === 'differs' && <Button variant="ghost-wrap" size="sm" onClick={() => onDiff(tool)}>View difference</Button>}
    {pushable && onPush && <Button variant="ghost-wrap" size="sm" aria-label={cell.kind === 'missing' ? `Add copy to ${copyAgentLabel(tool.tool)}` : undefined} onClick={() => onPush(tool.tool, skillName)}>{cell.kind === 'missing' ? 'Add copy' : `Copy Claude's version to ${copyAgentLabel(tool.tool)}`}</Button>}
    {pushed && onPushUndo && <Button variant="ghost-wrap" size="sm" aria-label={`Undo pushing ${skillName} into ${copyAgentLabel(tool.tool)}`} onClick={() => onPushUndo(tool.tool, skillName)}>Undo copy</Button>}
  </SettingsToolbar>
}
function CopyDifference({ diff, onClose }: { diff: { tool: AgentKind; content?: { claude: string; other: string }; error?: string }; onClose: () => void }): React.JSX.Element {
  return <div className="grid gap-[var(--space-2)]">
    <div className="flex items-center justify-between"><Text size="small" weight="semibold">Claude Code vs {copyAgentLabel(diff.tool)}</Text><Button variant="ghost-wrap" size="sm" onClick={onClose}>Close</Button></div>
    {diff.error ? <Text tone="danger">{diff.error}</Text> : diff.content ? <PanelColumns><CodePane size="diff">{diff.content.claude}</CodePane><CodePane size="diff">{diff.content.other}</CodePane></PanelColumns> : <Text tone="faint">Reading both copies…</Text>}
  </div>
}
export function SkillItemDistribution({ skillName, tools, pushes, onPush, onPushUndo }: Omit<CopyTableProps, 'row'>): React.JSX.Element | null {
  const row = buildSkillRows(tools).find(item => item.name === skillName)
  const others = tools.filter(tool => tool.detected && tool.tool !== 'claude')
  if (!row?.claude || !others.length) return null
  return <SkillCopyTable skillName={skillName} row={row} tools={others} pushes={pushes} onPush={onPush} onPushUndo={onPushUndo} />
}
