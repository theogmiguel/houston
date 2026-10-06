import { useState } from 'react'
import { StatusIcon, type StatusIconState } from './ui/StatusIcon'
import { Tooltip } from './ui/Tooltip'
import { IconRespawn } from './icons'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { SkillToolState } from '../houston/generated/SkillToolState'
import type { SkillPushRecord } from '../houston/generated/SkillPushRecord'
import { buildSkillRows, needsPush, skillCellFor, skillCellTitle } from '../houston/skillRows'
import { readFile } from '../houston/bridge'
import { BlockBar, BlockBarList, BlockLabelCell, CodePane } from './ui/Block'
import { Card } from './ui/Card'
import { Icon } from './ui/Icon'
import { PanelButton, PanelColumns, PanelIconButton } from './ui/PanelControls'
import { Text } from './ui/Text'

const TOOL_LABEL: Partial<Record<AgentKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor'
}

function label(tool: AgentKind): string {
  return TOOL_LABEL[tool] ?? tool
}

const SKILL_STATE: Record<ReturnType<typeof skillCellFor>['kind'], StatusIconState> = {
  same: 'ok',
  differs: 'differs',
  inherited: 'off',
  missing: 'absent'
}

const CELL_STATUS: Record<ReturnType<typeof skillCellFor>['kind'], string> = {
  same: 'Its own copy',
  differs: "Its own copy, differs from Claude Code's",
  inherited: "No copy of its own — sees Claude Code's",
  missing: 'Not visible here'
}

export function SkillItemDistribution({
  skillName,
  tools,
  pushes,
  onPush,
  onPushUndo
}: {
  skillName: string
  tools: SkillToolState[]
  pushes: SkillPushRecord[]
  onPush: (tool: AgentKind, skill: string) => void
  onPushUndo: (tool: AgentKind, skill: string) => void
}): React.JSX.Element | null {
  const [diffTool, setDiffTool] = useState<AgentKind | null>(null)
  const [diffContent, setDiffContent] = useState<{ claude: string; other: string } | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)

  const row = buildSkillRows(tools).find((r) => r.name === skillName)
  if (!row || !row.claude) return null
  const others = tools.filter((t) => t.tool !== 'claude')
  if (others.length === 0) return null

  const openDiff = (tool: SkillToolState): void => {
    const entry = row.byTool[tool.tool]
    if (!entry || !row.claude) return
    setDiffTool(tool.tool)
    setDiffContent(null)
    setDiffError(null)
    Promise.all([readFile(row.claude.path), readFile(entry.path)])
      .then(([claude, other]) => setDiffContent({ claude, other }))
      .catch((e: Error) => setDiffError(e.message))
  }

  return (
    <Card tone="block" shape="md" data-testid="skill-item-distribution">
      <BlockBar edge="bottom" text="faint">
        Distribution — Claude Code&apos;s copy is the source; the table shows what each other tool
        sees.
      </BlockBar>
      <BlockBarList>
        {others.map((tool) => {
          const cell = skillCellFor(row, tool)
          const pushable = needsPush(row, tool)
          const push = pushes.find((p) => p.tool === tool.tool && p.skill === skillName)
          return (
            <BlockBar as="li" edge="rows" text="small" key={tool.tool} className="flex items-center gap-[var(--space-2)]">
              <span className="flex-none">
                <StatusIcon state={SKILL_STATE[cell.kind]} />
              </span>
              <BlockLabelCell>{label(tool.tool)}</BlockLabelCell>
              <Text tone="secondary" className="flex-1 min-w-0 truncate">
                <Tooltip label={skillCellTitle(cell, label(tool.tool))}>
                  <span>{CELL_STATUS[cell.kind]}</span>
                </Tooltip>
              </Text>
              {cell.kind === 'differs' && <PanelIconButton onClick={() => openDiff(tool)}>View difference</PanelIconButton>}
              {pushable && (
                <PanelButton onClick={() => onPush(tool.tool, skillName)}>
                  Copy Claude&apos;s version to {label(tool.tool)}
                </PanelButton>
              )}
              {push && (
                <Tooltip label="Undo this push">
                  <PanelIconButton
                    aria-label={`Undo pushing ${skillName} into ${label(tool.tool)}`}
                    onClick={() => onPushUndo(tool.tool, skillName)}
                  >
                    <Icon glyph={IconRespawn} role="small" />
                  </PanelIconButton>
                </Tooltip>
              )}
            </BlockBar>
          )
        })}
      </BlockBarList>
      {diffTool && (
        <BlockBar edge="top" pad="lg" className="grid gap-[var(--space-2)]">
          <Text as="div" size="small" weight="semibold" tone="secondary" className="flex items-center justify-between">
            Claude Code vs {label(diffTool)}
            <PanelIconButton onClick={() => setDiffTool(null)}>Close</PanelIconButton>
          </Text>
          {diffError && <Text as="div" tone="danger">{diffError}</Text>}
          {!diffError && !diffContent && <Text as="div" tone="faint">Reading both copies…</Text>}
          {diffContent && (
            <PanelColumns>
              <CodePane size="diff">{diffContent.claude}</CodePane>
              <CodePane size="diff">{diffContent.other}</CodePane>
            </PanelColumns>
          )}
        </BlockBar>
      )}
    </Card>
  )
}
