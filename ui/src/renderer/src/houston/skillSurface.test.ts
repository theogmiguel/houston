import { describe, expect, it } from 'vitest'
import type { Skill } from '../env'
import type { SkillToolState } from './generated/SkillToolState'
import { canUseSkillInFocusedPane, skillCliRelations, skillInvocationFor, skillRelationLines, skillScopeLabel, skillUsageLine } from './skillSurface'
import type { SessionInfo } from './generated/SessionInfo'

const skill: Skill = {
  agent: 'claude',
  source: 'user',
  name: 'ui-tokens',
  path: '/home/dev/.claude/skills/ui-tokens/SKILL.md',
  invoke: '/ui-tokens',
  description: ''
}

function tool(
  name: SkillToolState['tool'],
  options: Partial<SkillToolState> = {}
): SkillToolState {
  return {
    tool: name,
    path: `/home/dev/.${name}/skills`,
    detected: true,
    inherits_claude: false,
    skills: [],
    error: null,
    ...options
  }
}

describe('skill surface helpers', () => {
  it('names both skill scopes', () => {
    expect(skillScopeLabel(true)).toBe('User · This workspace')
    expect(skillScopeLabel(false)).toBe('User skills only')
  })

  it('allows running only in a live focused agent pane in the selected workspace', () => {
    const pane = { agent: 'claude', state: 'running', project_dir: '/p' } as SessionInfo
    const sessions = new Map([[1, pane]])
    expect(canUseSkillInFocusedPane(sessions, 1, '/p', 'ready')).toBe(true)
    expect(canUseSkillInFocusedPane(sessions, 1, 'all', 'ready')).toBe(true)
    expect(canUseSkillInFocusedPane(new Map([[1, { ...pane, agent: 'shell' }]]), 1, '/p', 'ready')).toBe(false)
    expect(canUseSkillInFocusedPane(new Map([[1, { ...pane, project_dir: '/other' }]]), 1, '/p', 'ready')).toBe(false)
    expect(canUseSkillInFocusedPane(sessions, null, '/p', 'ready')).toBe(false)
    expect(canUseSkillInFocusedPane(sessions, 1, '/p', 'reconnecting')).toBe(false)
  })

  it('reports the real relation for every CLI in the approved surface', () => {
    const rows = skillCliRelations(skill, [
      tool('claude', { skills: [{ name: skill.name, path: skill.path, digest: 'same' }] }),
      tool('codex', { skills: [{ name: skill.name, path: '/codex/ui-tokens', digest: 'same' }] }),
      tool('opencode', { inherits_claude: true }),
      tool('cursor', { inherits_claude: true }),
      tool('grok', { inherits_claude: true })
    ])

    expect(rows.map(({ label, relation }) => [label, relation])).toEqual([
      ['Claude Code', 'source · user'],
      ['Codex', 'copy in sync'],
      ['OpenCode', 'reads Claude Code’s copy'],
      ['Cursor', 'reads Claude Code’s copy'],
      ['Grok', 'reads Claude Code’s copy'],
      ['Antigravity', 'not managed here']
    ])
  })

  it('counts sessions from the last Harness digest and names missing reviews', () => {
    const digest = [
      JSON.stringify({ skills: { 'ui-tokens': 1 } }),
      JSON.stringify({ skills: {} }),
      JSON.stringify({ skills: { 'ui-tokens': 2 } })
    ].join('\n')
    expect(skillUsageLine('ui-tokens', digest, true)).toBe(
      'Used in 2 of 3 sessions · from the last Harness review'
    )
    expect(skillUsageLine('ui-tokens', null, false)).toBe(
      'Usage appears after the first Harness review.'
    )
  })
})

describe('skillRelationLines', () => {
  it('joins the CLIs that share a relation into one line, in order', () => {
    expect(skillRelationLines([
      { tool: 'claude', label: 'Claude Code', relation: 'source · user' },
      { tool: 'codex', label: 'Codex', relation: 'copy in sync' },
      { tool: 'opencode', label: 'OpenCode', relation: 'reads Claude Code’s copy' },
      { tool: 'cursor', label: 'Cursor', relation: 'reads Claude Code’s copy' },
      { tool: 'grok', label: 'Grok', relation: 'reads Claude Code’s copy' },
      { tool: 'antigravity', label: 'Antigravity', relation: 'not managed here' }
    ])).toEqual([
      'Claude Code · source · user',
      'Codex · copy in sync',
      'OpenCode, Cursor, Grok · reads Claude Code’s copy',
      'Antigravity · not managed here'
    ])
  })
})

describe('skillInvocationFor', () => {
  it('runs a skill in ZCode through /skill and leaves other agents on /<name>', () => {
    expect(skillInvocationFor('zcode', '/ui-tokens')).toBe('/skill ui-tokens')
    expect(skillInvocationFor('zcode', '/git:commit')).toBe('/skill git:commit')
    expect(skillInvocationFor('claude', '/ui-tokens')).toBe('/ui-tokens')
    expect(skillInvocationFor(null, '/ui-tokens')).toBe('/ui-tokens')
  })
})
