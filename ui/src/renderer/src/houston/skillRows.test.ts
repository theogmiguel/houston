import { describe, expect, it } from 'vitest'
import { buildSkillRows, skillCellFor, skillCellTitle } from './skillRows'
import type { SkillToolState } from './generated/SkillToolState'
import type { AgentKind } from './generated/AgentKind'

function column(
  tool: AgentKind,
  skills: Array<[string, string]>,
  opts: { detected?: boolean; inherits?: boolean } = {}
): SkillToolState {
  return {
    tool,
    path: `/home/dev/${tool}/skills`,
    detected: opts.detected ?? true,
    inherits_claude: opts.inherits ?? (tool === 'opencode' || tool === 'cursor'),
    skills: skills.map(([name, digest]) => ({
      name,
      path: `/home/dev/${tool}/skills/${name}/SKILL.md`,
      digest
    })),
    error: null
  }
}

describe('the skills matrix fold (row 37)', () => {
  it('never calls a skill missing from a tool that reads Claude’s directory', () => {
    const tools = [column('claude', [['triage', 'A']]), column('cursor', [])]
    const rows = buildSkillRows(tools)
    const cell = skillCellFor(rows[0], tools[1])
    expect(cell.kind).toBe('inherited')
    expect(skillCellTitle(cell, 'Cursor')).toContain('reads Claude Code')
  })

  it('does call it missing for a tool that does NOT read Claude’s directory', () => {
    const tools = [column('claude', [['triage', 'A']]), column('codex', [])]
    const rows = buildSkillRows(tools)
    expect(skillCellFor(rows[0], tools[1]).kind).toBe('missing')
  })

  it('flags a native copy whose content drifted', () => {
    const tools = [column('claude', [['triage', 'A']]), column('cursor', [['triage', 'B']])]
    const rows = buildSkillRows(tools)
    expect(rows[0].hasDrift).toBe(true)
    expect(skillCellFor(rows[0], tools[1]).kind).toBe('differs')
    expect(skillCellFor(rows[0], tools[0]).kind).toBe('differs')
  })

  it('leaves identical copies alone', () => {
    const tools = [column('claude', [['triage', 'A']]), column('cursor', [['triage', 'A']])]
    const rows = buildSkillRows(tools)
    expect(rows[0].hasDrift).toBe(false)
    expect(skillCellFor(rows[0], tools[1]).kind).toBe('same')
  })

  it('shows a skill only one tool has, and does not inherit what Claude lacks', () => {
    const tools = [column('claude', []), column('codex', [['codex-only', 'C']]), column('cursor', [])]
    const rows = buildSkillRows(tools)
    expect(rows.map((r) => r.name)).toEqual(['codex-only'])
    expect(skillCellFor(rows[0], tools[2]).kind).toBe('missing')
  })
})
