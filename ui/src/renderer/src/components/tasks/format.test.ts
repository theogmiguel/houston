import { describe, expect, it } from 'vitest'
import type { TaskHistoryEntry } from '../../houston/generated/TaskHistoryEntry'
import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import {
  acceptanceText,
  actorLabel,
  compareTasks,
  describeTaskChanges,
  formatAge,
  formatAgo,
  groupTasks,
  historyLine
} from './format'

function task(overrides: Partial<TaskSummary> & { id: number }): TaskSummary {
  return {
    workspace: '/w',
    number: overrides.id,
    key: `HOU-${overrides.id}`,
    title: `task ${overrides.id}`,
    status: 'todo',
    priority: 'none' as TaskPriority,
    parent_id: null,
    ref_url: null,
    revision: 1,
    created_by: 'user',
    created_at_ms: 0,
    updated_at_ms: 0,
    archived_at_ms: null,
    acceptance_checked: 0,
    acceptance_total: 0,
    ...overrides
  }
}

describe('compareTasks / groupTasks', () => {
  it('sorts urgent > high > medium > low > none, then updated desc', () => {
    const none = task({ id: 1, priority: 'none', updated_at_ms: 900 })
    const low = task({ id: 2, priority: 'low', updated_at_ms: 100 })
    const medium = task({ id: 3, priority: 'medium', updated_at_ms: 100 })
    const high = task({ id: 4, priority: 'high', updated_at_ms: 100 })
    const urgent = task({ id: 5, priority: 'urgent', updated_at_ms: 100 })
    const highOlder = task({ id: 6, priority: 'high', updated_at_ms: 50 })
    const sorted = [none, low, medium, high, urgent, highOlder].sort(compareTasks)
    expect(sorted.map((t) => t.id)).toEqual([5, 4, 6, 3, 2, 1])
  })

  it('groups in status order, drops empty groups, and moves archived tasks to a trailing group', () => {
    const progress = task({ id: 1, status: 'in_progress' })
    const done = task({ id: 2, status: 'done' })
    const archived = task({ id: 3, status: 'todo', archived_at_ms: 42 })
    const groups = groupTasks([progress, done, archived])
    expect(groups.map((g) => g.key)).toEqual(['in_progress', 'done', 'archived'])
    expect(groups[2].tasks.map((t) => t.id)).toEqual([3])
    expect(groupTasks([])).toEqual([])
  })
})

describe('age formatting', () => {
  const now = 1_700_000_000_000
  it('reads now / minutes / hours / days', () => {
    expect(formatAge(now, now)).toBe('now')
    expect(formatAge(now - 8 * 60_000, now)).toBe('8m')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d')
    expect(formatAgo(now, now)).toBe('just now')
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('2h ago')
  })
})

function history(overrides: Partial<TaskHistoryEntry>): TaskHistoryEntry {
  return { id: 1, actor: 'user', action: 'update', changes: '{}', created_at_ms: 0, ...overrides }
}

describe('activity copy', () => {
  it('names the fields an update moved', () => {
    expect(describeTaskChanges('{"title":{"from":"a","to":"b"}}')).toBe('title')
    expect(describeTaskChanges('{"status":{"from":"todo","to":"done"},"priority":{"from":"none","to":"high"}}')).toBe(
      'status and priority'
    )
    expect(describeTaskChanges('not json')).toBe('this task')
  })

  it('renders a line per action and skips comment history', () => {
    expect(historyLine(history({ action: 'create' }))).toEqual({ verb: 'created this task' })
    expect(historyLine(history({ action: 'comment', changes: '{"comment":3}' }))).toBeNull()
    expect(historyLine(history({ action: 'check', changes: '{"item":1,"text":"fails before"}' }))).toEqual({
      verb: 'checked an acceptance item',
      detail: '“fails before”'
    })
  })

  it('labels the reader as You and leaves attribution strings intact', () => {
    expect(actorLabel('user')).toBe('You')
    expect(actorLabel('agent:backend (tests)')).toBe('agent:backend (tests)')
    expect(acceptanceText(2, 3)).toBe('2 / 3')
  })
})
