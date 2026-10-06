import { describe, expect, it } from 'vitest'
import type { TaskHistoryEntry } from '../../houston/generated/TaskHistoryEntry'
import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import {
  acceptanceText,
  actorLabel,
  compareTasks,
  describeTaskChanges,
  formatAge,
  formatAgo,
  groupTasks,
  historyLine,
  nowRunLabel,
  parseReworkRounds,
  queuePreview,
  queueActionOf,
  queueGroups,
  runIsOpen,
  runNextCount,
  runNextDisabledReason,
  runStateLabel,
  runStateTone,
  taskAgentLabel,
  taskDraftFromSelection,
  taskReviewOutcome
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
    children_total: 0,
    children_done: 0,
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

describe('Tasks page queue', () => {
  it('groups each queue state and folds done and archived below the queue', () => {
    const waiting = task({ id: 1, status: 'in_progress', open_run: run({ id: 1, state: 'waiting_for_input' }) })
    const review = task({ id: 2, status: 'in_review' })
    const working = task({ id: 3, status: 'in_progress', open_run: run({ id: 3, state: 'running' }) })
    const stopped = task({ id: 4, status: 'in_progress' })
    const next = task({ id: 5, status: 'todo' })
    const done = task({ id: 6, status: 'done' })
    const archived = task({ id: 7, archived_at_ms: 7 })
    expect(queueGroups([waiting, review, working, stopped, next, done, archived]).map((group) => [group.key, group.tasks.map((item) => item.id)])).toEqual([
      ['your-turn', [2, 1]], ['working', [3]], ['stopped', [4]], ['up-next', [5]], ['done', [6, 7]]
    ])
  })

  it('maps each supported state to the matching action', () => {
    expect(queueActionOf(task({ id: 1, status: 'in_progress', open_run: run({ id: 1, state: 'waiting_for_input' }) }))).toBe('Answer')
    expect(queueActionOf(task({ id: 2, status: 'in_review', ref_url: 'https://github.com/org/repo/pull/61' }))).toBe('Open PR')
    expect(queueActionOf(task({ id: 3, status: 'in_progress', open_run: run({ id: 3, state: 'running', session_id: 23 }) }))).toBe('Open pane')
    expect(queueActionOf(task({ id: 4, status: 'in_progress' }))).toBe('Start again')
    expect(queueActionOf(task({ id: 5, status: 'todo' }))).toBe('Start')
    expect(queueActionOf(task({ id: 6, status: 'in_review' }))).toBe('Review changes')
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

function run(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 7,
    task_id: 41,
    attempt: 2,
    kind: 'implementation',
    state: 'running',
    provider: 'claude',
    reviewer: null,
    session_id: 431,
    delegation_id: null,
    worktree_path: null,
    branch: null,
    base_commit: null,
    initial_revision: 1,
    summary: null,
    reason: null,
    started_at_ms: 0,
    ended_at_ms: null,
    ...overrides
  }
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

  it('names the attempt a start or resume opened from the run diff', () => {
    const runs = [run({ id: 7, attempt: 2 })]
    expect(historyLine(history({ action: 'start', changes: '{"run":7}' }), runs)).toEqual({
      verb: 'started attempt 2'
    })
    expect(historyLine(history({ action: 'resume', changes: '{"run":7}' }), runs)).toEqual({
      verb: 'resumed attempt 2'
    })
    expect(historyLine(history({ action: 'start', changes: '{}' }), runs)).toEqual({ verb: 'started a run' })
  })

  it('renders claim, handback and derived moves as sentences, never raw actions', () => {
    expect(historyLine(history({ action: 'claim' }))).toEqual({ verb: 'claimed this task' })
    expect(historyLine(history({ action: 'handback' }))).toEqual({ verb: 'moved to In review' })
    expect(historyLine(history({ action: 'pane_working' }))).toEqual({
      verb: 'moved to In progress',
      system: 'from pane status'
    })
    expect(historyLine(history({ action: 'pr_merged' }))).toEqual({
      verb: 'moved to Done',
      system: 'pull request merged'
    })
    expect(historyLine(history({ action: 'some_new_action' }))).toEqual({ verb: 'some new action' })
  })

  it('labels the reader as You and shortens daemon actors', () => {
    expect(actorLabel('user')).toBe('You')
    expect(actorLabel('agent:backend (tests)')).toBe('backend')
    expect(actorLabel('houston:pane-working')).toBe('Houston')
    expect(acceptanceText(2, 3)).toBe('2 / 3')
  })
})

describe('run state mapping', () => {
  it('maps every state to its label, with the reviewer failure named as the mock does', () => {
    expect(runStateLabel('preparing')).toBe('Preparing')
    expect(runStateLabel('running')).toBe('Working')
    expect(runStateLabel('waiting_for_input')).toBe('Needs you')
    expect(runStateLabel('validating')).toBe('Validating')
    expect(runStateLabel('handed_back')).toBe('Handed back')
    expect(runStateLabel('needs_review')).toBe('Needs review')
    expect(runStateLabel('failed')).toBe('Failed')
    expect(runStateLabel('failed', 'review')).toBe('Review failed')
    expect(runStateLabel('cancelled')).toBe('Stopped')
    expect(runStateLabel('interrupted')).toBe('Interrupted')
  })

  it('maps states to the mock dot and label tones', () => {
    expect(runStateTone('preparing')).toBe('spawning')
    expect(runStateTone('running')).toBe('working')
    expect(runStateTone('waiting_for_input')).toBe('needs')
    expect(runStateTone('handed_back')).toBe('done')
    expect(runStateTone('failed')).toBe('failed')
    expect(runStateTone('interrupted')).toBe('needs')
    expect(runStateTone('cancelled')).toBe('idle')
  })

  it('knows which states still hold a pane', () => {
    expect(runIsOpen('preparing')).toBe(true)
    expect(runIsOpen('running')).toBe(true)
    expect(runIsOpen('waiting_for_input')).toBe(true)
    expect(runIsOpen('validating')).toBe(true)
    expect(runIsOpen('handed_back')).toBe(false)
    expect(runIsOpen('interrupted')).toBe(false)
    expect(runIsOpen('cancelled')).toBe(false)
  })

  it('names the task providers as the Start menu shows them', () => {
    expect(taskAgentLabel('claude')).toBe('Claude')
    expect(taskAgentLabel('opencode')).toBe('OpenCode')
    expect(taskAgentLabel('grok')).toBe('Grok')
  })

  it('shows the task status while the run is open and Needs you when the pane waits', () => {
    expect(nowRunLabel('running', 'in_progress')).toBe('In progress')
    expect(nowRunLabel('preparing', 'todo')).toBe('Todo')
    expect(nowRunLabel('waiting_for_input', 'in_progress')).toBe('Needs you')
    expect(nowRunLabel('interrupted', 'in_progress')).toBe('Interrupted')
    expect(nowRunLabel('handed_back', 'in_review')).toBe('Handed back')
    expect(nowRunLabel(null, 'todo')).toBeNull()
  })
})

describe('the roster queue', () => {
  it('caps Run next N by the ready pool and the free child slots', () => {
    expect(runNextCount(2, 2, 4)).toBe(2)
    expect(runNextCount(5, 3, 4)).toBe(1)
    expect(runNextCount(2, 4, 4)).toBe(0)
    expect(runNextCount(2, 5, 4)).toBe(0)
    expect(runNextCount(2, 1, null)).toBe(0)
  })

  it('names the limit that disabled Run next N', () => {
    expect(runNextDisabledReason(0, 1, 4)).toBe('No ready tasks')
    expect(runNextDisabledReason(2, 4, 4)).toContain('cap of 4')
    expect(runNextDisabledReason(2, 5, 4)).toContain('cap of 4')
    expect(runNextDisabledReason(2, 1, null)).toContain('not loaded')
    expect(runNextDisabledReason(2, 1, 4)).toBeNull()
  })

  it('previews the daemon ready order: todo, no open run, priority then oldest number', () => {
    const preview = queuePreview([
      task({ id: 3, number: 3, status: 'backlog', priority: 'urgent' }),
      task({ id: 4, number: 4, status: 'todo', priority: 'none' }),
      task({ id: 5, number: 5, status: 'todo', priority: 'high' }),
      task({ id: 6, number: 6, status: 'todo', priority: 'high' }),
      task({ id: 7, number: 7, status: 'todo', priority: 'urgent', open_run: run({ id: 1, state: 'running' }) }),
      task({ id: 8, number: 8, status: 'todo', priority: 'urgent', archived_at_ms: 5 })
    ])
    expect(preview.map((t) => t.id)).toEqual([5, 6, 4])
  })
})

describe('New task from selection', () => {
  it('takes the first line as the title and the whole selection as the description', () => {
    expect(taskDraftFromSelection('flaky: worktree_cleanup::sweeps_merged\nsecond line')).toEqual({
      title: 'flaky: worktree_cleanup::sweeps_merged',
      description: 'flaky: worktree_cleanup::sweeps_merged\nsecond line'
    })
  })

  it('truncates the title to the daemon cap and refuses a blank selection', () => {
    const long = 'x'.repeat(300)
    expect(taskDraftFromSelection(long)?.title).toHaveLength(200)
    expect(taskDraftFromSelection('   \n  ')).toBeNull()
  })
})

describe('rework rounds validation', () => {
  it('accepts whole numbers inside 0..max', () => {
    expect(parseReworkRounds('0', 3, 5)).toEqual({ value: 0, error: null })
    expect(parseReworkRounds('5', 0, 5)).toEqual({ value: 5, error: null })
    expect(parseReworkRounds(' 2 ', 0, 5)).toEqual({ value: 2, error: null })
  })

  it('refuses out-of-range and non-integer drafts naming limit, requested and kept value', () => {
    const high = parseReworkRounds('7', 3, 5)
    expect(high.value).toBeNull()
    expect(high.error).toContain('0..5')
    expect(high.error).toContain('7')
    expect(high.error).toContain('kept 3')
    const negative = parseReworkRounds('-1', 3, 5)
    expect(negative.value).toBeNull()
    expect(negative.error).toContain('-1')
    const fraction = parseReworkRounds('2.5', 3, 5)
    expect(fraction.value).toBeNull()
    expect(fraction.error).toContain('2.5')
    const blank = parseReworkRounds('', 3, 5)
    expect(blank.value).toBeNull()
    expect(blank.error).toContain('whole number')
  })
})

describe('review outcome', () => {
  it('reads a failed review from the review run and retries the implementation run', () => {
    const outcome = taskReviewOutcome(
      [
        run({ id: 9, kind: 'review', state: 'needs_review', provider: 'codex', summary: '- missing test' }),
        run({ id: 8, state: 'needs_review', reviewer: 'codex' })
      ],
      []
    )
    expect(outcome).toEqual({
      reviewer: 'codex',
      verdict: 'fail',
      findings: '- missing test',
      retryRunId: 8
    })
  })

  it('reads a pass and falls back to the verdict comment for findings', () => {
    const passed = taskReviewOutcome(
      [run({ id: 9, kind: 'review', state: 'handed_back', provider: 'codex', summary: '(no findings)' })],
      []
    )
    expect(passed?.verdict).toBe('pass')
    expect(passed?.retryRunId).toBeNull()
    const failed = taskReviewOutcome(
      [run({ id: 8, state: 'needs_review', reviewer: 'codex' })],
      [{ id: 1, author: 'agent:rev', body: 'Review verdict: fail\n\n- no regression test', created_at_ms: 5 }]
    )
    expect(failed?.verdict).toBe('fail')
    expect(failed?.findings).toBe('- no regression test')
  })

  it('has no verdict while the implementation run is still open or no reviewer is set', () => {
    expect(taskReviewOutcome([run({ id: 8, state: 'running', reviewer: 'codex' })], [])).toBeNull()
    expect(taskReviewOutcome([run({ id: 8, state: 'handed_back' })], [])).toBeNull()
    expect(taskReviewOutcome([], [])).toBeNull()
  })
})
