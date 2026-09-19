import { useState } from 'react'
import { Toggle } from './settingsPrimitives'
import { StatusIcon, type StatusIconState } from './StatusIcon'
import { Tooltip } from './Tooltip'
import { IconFile, IconRespawn } from './icons'
import { BLOCK, CHROME_BUTTON, NavDetailState, NavEmpty, SECONDARY_BUTTON } from './nav/navChrome'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { SkillToolState } from '../houston/generated/SkillToolState'
import type { SkillPushRecord } from '../houston/generated/SkillPushRecord'
import { buildSkillRows, needsPush, skillCellFor, skillCellTitle } from '../houston/skillRows'
import { readFile } from '../houston/bridge'
import { Icon } from './Icon'

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

export function SkillMatrix({
  tools,
  loaded,
  pushes,
  autoPushEnabled,
  onRefresh,
  onPush,
  onPushUndo,
  onAutoPushSet
}: {
  tools: SkillToolState[]
  loaded: boolean
  pushes: SkillPushRecord[]
  autoPushEnabled: boolean
  onRefresh: () => void
  onPush: (tool?: AgentKind, skill?: string) => void
  onPushUndo: (tool: AgentKind, skill: string) => void
  onAutoPushSet: (enabled: boolean) => void
}): React.JSX.Element {
  const rows = buildSkillRows(tools)
  if (!loaded) {
    return (
      <NavDetailState
        testId="skill-matrix-loading"
        title="Reading the CLIs’ folders…"
        detail="Asking the daemon which skills each tool can see."
      />
    )
  }
  const drifted = rows.some((row) => tools.some((t) => needsPush(row, t)))
  return (
    <div className={BLOCK}>
      <div className="flex items-center gap-[8px] border-b border-[var(--divider)] px-[14px] py-[9px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
        <span className="flex-1">
          <span className="tabular-nums">{rows.length}</span> across{' '}
          <span className="tabular-nums">{tools.filter((t) => t.detected).length}</span> tool
          {tools.filter((t) => t.detected).length === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-[5px] text-[var(--text-secondary)]">
          <Toggle on={autoPushEnabled} onChange={onAutoPushSet} data-testid="skills-auto-push" />
          <span>Auto-push drift</span>
        </div>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={!drifted}
          onClick={() => onPush()}
        >
          Push all drifted
        </button>
        <button type="button" className={SECONDARY_BUTTON} onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {rows.length === 0 ? (
        <NavEmpty
          testId="skill-matrix-empty"
          title="No skills found"
          icon={<Icon glyph={IconFile} role="display" />}
          action={
            <button type="button" className={SECONDARY_BUTTON} onClick={onRefresh}>
              Refresh
            </button>
          }
        >
          Nothing in any detected tool&apos;s skills directory.
        </NavEmpty>
      ) : (
        <table className="w-full border-collapse [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
          <thead>
            <tr>
              <th className="px-[14px] py-[8px] text-left [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
                Skill
              </th>
              {tools.map((t) => (
                <th
                  key={t.tool}
                  className="w-[90px] px-[8px] py-[8px] text-center [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]"
                >
                  <Tooltip label={t.detected ? t.path : `${t.path} — no skills directory here`}>
                    {label(t.tool)}
                  </Tooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-t border-[var(--divider)]">
                <td className="px-[14px] py-2 font-medium text-[var(--text-primary)]">{row.name}</td>
                {tools.map((t) => {
                  const cell = skillCellFor(row, t)
                  const pushable = needsPush(row, t)
                  const glyph = (
                    <Tooltip
                      label={
                        pushable
                          ? `${skillCellTitle(cell, label(t.tool))} — click to push Claude Code's copy here`
                          : skillCellTitle(cell, label(t.tool))
                      }
                    >
                      <span data-skill-cell={cell.kind}>
                        <StatusIcon state={SKILL_STATE[cell.kind]} />
                      </span>
                    </Tooltip>
                  )
                  return (
                    <td key={t.tool} className="px-2 py-2 text-center">
                      {pushable ? (
                        <button
                          className="border-0 bg-transparent cursor-pointer hover:brightness-125"
                          aria-label={`Push ${row.name} into ${label(t.tool)}`}
                          onClick={() => onPush(t.tool, row.name)}
                        >
                          {glyph}
                        </button>
                      ) : (
                        glyph
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="border-t border-[var(--divider)] px-[14px] py-[9px] flex flex-wrap items-center gap-x-[14px] gap-y-[4px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-muted)]">
        <StatusIcon state="ok" label="its own copy" />
        <StatusIcon state="differs" label="its own copy, differing" />
        <StatusIcon state="off" label="no copy of its own, sees Claude Code's" />
        <StatusIcon state="absent" label="cannot see it" />
        <span>A drifted or missing cell is clickable — it pushes Claude Code&apos;s copy there.</span>
      </div>
      {pushes.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-[var(--divider)] px-[14px] py-[9px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
          <div className=" [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
            Pushed by Houston
          </div>
          <ul className="flex flex-col gap-1">
            {pushes.map((p) => (
              <li key={`${p.tool}:${p.skill}`} className="flex items-center gap-2">
                <span className="flex-1 text-[var(--text-secondary)]">
                  {p.skill} → {label(p.tool)}
                  <span className="text-[var(--text-faint)]">
                    {' '}
                    · {p.had_existing ? 'overwrote a drifted copy' : 'created new'}
                  </span>
                </span>
                <Tooltip label="Undo this push">
                  <button
                    type="button"
                    className={CHROME_BUTTON}
                    aria-label={`Undo pushing ${p.skill} into ${label(p.tool)}`}
                    onClick={() => onPushUndo(p.tool, p.skill)}
                  >
                    <Icon glyph={IconRespawn} role="small" />
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
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
    <div className={BLOCK} data-testid="skill-item-distribution">
      <div className="px-[14px] py-[9px] border-b border-[var(--divider)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
        Distribution — Claude Code&apos;s copy is the source; the table shows what each other tool
        sees.
      </div>
      <ul className="flex flex-col">
        {others.map((tool) => {
          const cell = skillCellFor(row, tool)
          const pushable = needsPush(row, tool)
          const push = pushes.find((p) => p.tool === tool.tool && p.skill === skillName)
          return (
            <li
              key={tool.tool}
              className="flex items-center gap-[8px] px-[14px] py-[9px] border-t border-[var(--divider)] first:border-t-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]"
            >
              <span className="flex-none">
                <StatusIcon state={SKILL_STATE[cell.kind]} />
              </span>
              <span className="flex-none font-semibold text-[var(--text-primary)] w-[92px]">
                {label(tool.tool)}
              </span>
              <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">
                <Tooltip label={skillCellTitle(cell, label(tool.tool))}>
                  <span>{CELL_STATUS[cell.kind]}</span>
                </Tooltip>
              </span>
              {cell.kind === 'differs' && (
                <button type="button" className={CHROME_BUTTON} onClick={() => openDiff(tool)}>
                  View difference
                </button>
              )}
              {pushable && (
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  onClick={() => onPush(tool.tool, skillName)}
                >
                  Copy Claude&apos;s version to {label(tool.tool)}
                </button>
              )}
              {push && (
                <Tooltip label="Undo this push">
                  <button
                    type="button"
                    className={CHROME_BUTTON}
                    aria-label={`Undo pushing ${skillName} into ${label(tool.tool)}`}
                    onClick={() => onPushUndo(tool.tool, skillName)}
                  >
                    <Icon glyph={IconRespawn} role="small" />
                  </button>
                </Tooltip>
              )}
            </li>
          )
        })}
      </ul>
      {diffTool && (
        <div className="border-t border-[var(--divider)] px-[14px] py-[10px] flex flex-col gap-2">
          <div className="flex items-center justify-between [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]">
            Claude Code vs {label(diffTool)}
            <button type="button" className={CHROME_BUTTON} onClick={() => setDiffTool(null)}>
              Close
            </button>
          </div>
          {diffError && <div className="text-[var(--danger)]">{diffError}</div>}
          {!diffError && !diffContent && <div className="text-[var(--text-faint)]">Reading both copies…</div>}
          {diffContent && (
            <div className="grid grid-cols-1 gap-2 @[520px]/rpanel:grid-cols-2">
              <pre className="m-0 max-h-[200px] overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] p-2 font-mono leading-[1.5] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                {diffContent.claude}
              </pre>
              <pre className="m-0 max-h-[200px] overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] p-2 font-mono leading-[1.5] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                {diffContent.other}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

