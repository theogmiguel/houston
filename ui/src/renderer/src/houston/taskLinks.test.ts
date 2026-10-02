import { describe, expect, it } from 'vitest'
import { matchTaskKeys, rememberTaskKeys, taskIdForKey } from './taskLinks'
import type { TaskSummary } from './generated/TaskSummary'

function summary(id: number, key: string): TaskSummary {
  return {
    id,
    workspace: '/ws',
    number: id,
    key,
    title: `Task ${id}`,
    status: 'todo',
    priority: 'none',
    parent_id: null,
    ref_url: null,
    revision: 1,
    created_by: 'user',
    created_at_ms: 1,
    updated_at_ms: 1,
    archived_at_ms: null,
    acceptance_checked: 0,
    acceptance_total: 0
  }
}

describe('matchTaskKeys', () => {
  it('finds a standalone key with its offsets', () => {
    expect(matchTaskKeys('fixed in HOU-12 today')).toEqual([{ key: 'HOU-12', index: 9, length: 6 }])
  })

  it('finds every key on one line', () => {
    expect(matchTaskKeys('HOU-1 blocks HOU-2').map((m) => m.key)).toEqual(['HOU-1', 'HOU-2'])
  })

  it('ignores keys inside longer identifiers', () => {
    expect(matchTaskKeys('XHOU-1 and HOU-2x and HOU- and hou-3')).toEqual([])
  })

  it('ignores a bare prefix with no number', () => {
    expect(matchTaskKeys('the HOU- backlog')).toEqual([])
  })
})

describe('task key index', () => {
  it('resolves only keys a snapshot has loaded', () => {
    rememberTaskKeys('/ws/a', [summary(3, 'HOU-3')])
    expect(taskIdForKey('/ws/a', 'HOU-3')).toBe(3)
    expect(taskIdForKey('/ws/a', 'HOU-9')).toBeNull()
    expect(taskIdForKey('/ws/b', 'HOU-3')).toBeNull()
  })

  it('replaces the previous snapshot for the workspace', () => {
    rememberTaskKeys('/ws/c', [summary(1, 'HOU-1')])
    rememberTaskKeys('/ws/c', [summary(2, 'HOU-2')])
    expect(taskIdForKey('/ws/c', 'HOU-1')).toBeNull()
    expect(taskIdForKey('/ws/c', 'HOU-2')).toBe(2)
  })
})
