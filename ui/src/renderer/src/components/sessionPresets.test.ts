import { describe, expect, it } from 'vitest'
import {
  expandSlots,
  MAX_COUNT,
  SESSION_PRESETS,
  TASK_MAX_BYTES,
  taskByteLength,
  taskOverLimitMessage
} from './sessionPresets'

const byId = (id: string) => SESSION_PRESETS.find((p) => p.id === id)!

describe('the reference catalog, verbatim', () => {
  it('is exactly four presets, in the reference order', () => {
    expect(SESSION_PRESETS.map((p) => p.id)).toEqual(['solo', 'pair', 'workbench', 'swarm'])
  })

  it('carries the reference names, counts and blurbs', () => {
    expect(SESSION_PRESETS.map((p) => [p.name, p.count, p.blurb])).toEqual([
      ['Solo', 1, 'One agent in one terminal.'],
      ['Pair', 2, 'One builds, one reviews the same tree.'],
      ['Workbench', 2, 'An agent plus a shell for git and tests.'],
      ['Swarm', 4, 'Four agents fan out on parallel work.']
    ])
  })

  it('caps the count at the schema maximum', () => {
    expect(MAX_COUNT).toBe(6)
  })
})

describe('expandSlots', () => {
  it('Solo — one slot, the picked agent, the raw task as its prompt', () => {
    expect(expandSlots(byId('solo'), 'codex', 1, 'Fix the parser')).toEqual([
      { index: 0, agent: 'codex', roleLabel: null, prompt: 'Fix the parser' }
    ])
  })

  it('Pair — builder and reviewer, each with its role instruction ahead of the task', () => {
    const slots = expandSlots(byId('pair'), 'claude', 2, 'Fix the parser')
    expect(slots.map((s) => s.roleLabel)).toEqual(['builder', 'reviewer'])
    expect(slots[0].prompt).toBe(
      'You are the builder on this task. Implement it end to end.\n\nFix the parser'
    )
    expect(slots[1].prompt).toContain("don't write code unless asked.")
    expect(slots[1].prompt.endsWith('Fix the parser')).toBe(true)
  })

  it("Workbench — the shell slot's engine is forced regardless of the picked agent", () => {
    const slots = expandSlots(byId('workbench'), 'antigravity', 2, 'ship it')
    expect(slots.map((s) => s.agent)).toEqual(['antigravity', 'shell'])
  })

  it('a role-less preset gives every slot the same prompt and no role label', () => {
    const slots = expandSlots(byId('swarm'), 'claude', 4, 'go')
    expect(slots).toHaveLength(4)
    expect(slots.every((s) => s.roleLabel === null && s.prompt === 'go')).toBe(true)
  })

  it('a count above the role list repeats the roles; below it truncates', () => {
    expect(expandSlots(byId('pair'), 'claude', 3, '').map((s) => s.roleLabel)).toEqual([
      'builder',
      'reviewer',
      'builder'
    ])
    expect(expandSlots(byId('pair'), 'claude', 1, '').map((s) => s.roleLabel)).toEqual(['builder'])
  })

  it('an empty task leaves a role-less slot with no prompt at all', () => {
    expect(expandSlots(byId('solo'), 'claude', 1, '   ')[0].prompt).toBe('')
  })

  it('no preset (Custom) means no roles', () => {
    const slots = expandSlots(null, 'grok', 2, 'hi')
    expect(slots.map((s) => [s.agent, s.roleLabel, s.prompt])).toEqual([
      ['grok', null, 'hi'],
      ['grok', null, 'hi']
    ])
  })
})

describe('the task byte cap', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(taskByteLength('é')).toBe(2)
  })

  it('accepts a task exactly at the cap and names both numbers above it', () => {
    expect(taskOverLimitMessage('a'.repeat(TASK_MAX_BYTES))).toBeNull()
    const message = taskOverLimitMessage('a'.repeat(TASK_MAX_BYTES + 1))
    expect(message).toBe('Task is too long (8,193 of 8,192 bytes).')
  })
})
