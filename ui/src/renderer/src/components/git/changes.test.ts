import { describe, expect, it } from 'vitest'
import type { GitFileStatus } from '../../houston/client'
import {
  branchChipLabel,
  bulkLabelFor,
  pullDisabledReason,
  discardConfirmLabel,
  discardConfirmMessage,
  discardKindFor,
  flatRows,
  groupBulkDisabledReason,
  groupBulkPaths,
  groupRows,
  pushDisabledReason,
  prChecksLabel,
  prDecisionLabel,
  pushLabel,
  scopeLabels,
  splitPath,
  stageActionFor,
  stagedCount,
  stageAllPaths,
  tagFor,
  toRow,
  unstageAllPaths
} from './changes'

function file(o: Partial<GitFileStatus> = {}): GitFileStatus {
  return {
    path: 'src/app.ts',
    status: 'modified',
    staged: false,
    added: 1,
    deleted: 0,
    is_sensitive: false,
    ...o
  }
}

describe('the tag vocabulary (carried verbatim from ReviewPane)', () => {
  it('blocked outranks every other status', () => {
    expect(tagFor(file({ path: '.env.local', status: 'untracked', is_sensitive: true }))).toBe(
      'blocked'
    )
    expect(tagFor(file({ status: 'conflicted', is_sensitive: true }))).toBe('blocked')
  })

  it('trusts review.ts even when the daemon flag is false', () => {
    expect(tagFor(file({ path: 'config/credentials.json', is_sensitive: false }))).toBe('blocked')
  })

  it('maps the four ordinary states', () => {
    expect(tagFor(file({ status: 'conflicted' }))).toBe('conflict')
    expect(tagFor(file({ status: 'untracked' }))).toBe('untracked')
    expect(tagFor(file({ staged: true }))).toBe('staged')
    expect(tagFor(file({ staged: false }))).toBe('unstaged')
  })
})

describe('grouping', () => {
  it('lists a blocked file under the group of the change it IS, not a group of its own', () => {
    const rows = groupRows([file({ path: '.env', status: 'untracked', is_sensitive: true })])
    expect(rows).toHaveLength(1)
    expect(rows[0].group).toBe('untracked')
    expect(rows[0].rows[0].tag).toBe('blocked')
  })

  it('renders the four groups in order and drops empty ones', () => {
    const rows = groupRows([
      file({ path: 'a.ts', staged: true }),
      file({ path: 'b.ts', status: 'untracked' }),
      file({ path: 'c.ts', status: 'conflicted' })
    ])
    expect(rows.map((g) => g.group)).toEqual(['conflicted', 'staged', 'untracked'])
  })

  it('lists a file changed on BOTH sides once per side', () => {
    const rows = flatRows([
      file({ path: 'a.ts', staged: true }),
      file({ path: 'a.ts', staged: false })
    ])
    expect(rows.map((r) => r.group)).toEqual(['staged', 'unstaged'])
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })

  it('collapses a duplicate (group, path) — the branch scope stacks the working tree on top', () => {
    const rows = flatRows([
      file({ path: 'a.ts', staged: true, added: 9 }),
      file({ path: 'a.ts', staged: true, added: 9 })
    ])
    expect(rows).toHaveLength(1)
  })
})

describe('the stage action', () => {
  it('a blocked row offers none — staging it would be a commit made blind', () => {
    expect(stageActionFor(toRow(file({ path: '.env', is_sensitive: true })))).toBeNull()
  })
  it('a staged row unstages; everything else stages', () => {
    expect(stageActionFor(toRow(file({ staged: true })))).toBe('unstage')
    expect(stageActionFor(toRow(file({ staged: false })))).toBe('stage')
    expect(stageActionFor(toRow(file({ status: 'untracked' })))).toBe('stage')
    expect(stageActionFor(toRow(file({ status: 'conflicted' })))).toBe('stage')
  })
})

describe('discard', () => {
  it('maps each group to the git operation it actually means', () => {
    expect(discardKindFor(toRow(file({ staged: true })))).toBe('staged')
    expect(discardKindFor(toRow(file({ staged: false })))).toBe('unstaged')
    expect(discardKindFor(toRow(file({ status: 'untracked' })))).toBe('untracked')
  })

  it('a blocked row offers no discard', () => {
    expect(discardKindFor(toRow(file({ path: 'id_rsa', is_sensitive: true })))).toBeNull()
  })

  it('the untracked confirm is worded as a DELETE and names the file', () => {
    const row = toRow(file({ path: 'scratch.txt', status: 'untracked' }))
    expect(discardConfirmMessage(row)).toContain('Delete scratch.txt')
    expect(discardConfirmMessage(row)).toContain('cannot be undone')
    expect(discardConfirmLabel(row)).toBe('Delete file')
  })

  it('the tracked confirm names the file too', () => {
    const row = toRow(file({ path: 'src/app.ts' }))
    expect(discardConfirmMessage(row)).toContain('src/app.ts')
    expect(discardConfirmLabel(row)).toBe('Discard changes')
  })
})

describe('labels', () => {
  it('splits a path into a dimmable directory half and a name', () => {
    expect(splitPath('src/a/b.ts')).toEqual({ dir: 'src/a/', name: 'b.ts' })
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' })
  })

  it('the scope toggle names the base it would compare against', () => {
    expect(scopeLabels('main').branch).toBe('Branch vs main')
    expect(scopeLabels('origin/develop').branch).toBe('Branch vs origin/develop')
  })

  it('with no base resolved the toggle says so rather than naming a guess', () => {
    expect(scopeLabels(null).branch).toBe('Branch vs base')
  })

  it('the branch chip shows ahead/behind only when there is any', () => {
    expect(branchChipLabel('main', 2, 0)).toBe('main · ↑2')
    expect(branchChipLabel('main', 0, 3)).toBe('main · ↓3')
    expect(branchChipLabel('main', 2, 3)).toBe('main · ↑2 ↓3')
    expect(branchChipLabel('main', 0, 0)).toBe('main')
  })

  it('a detached HEAD says so rather than rendering an empty chip', () => {
    expect(branchChipLabel(null, 0, 0)).toBe('detached')
  })
})

describe('the staged count', () => {
  it('counts distinct paths — a path staged twice is one file to commit', () => {
    expect(
      stagedCount([
        file({ path: 'a.ts', staged: true }),
        file({ path: 'a.ts', staged: true }),
        file({ path: 'b.ts', staged: false })
      ])
    ).toBe(1)
  })
})

describe('the bulk sets (carried from GitPanel.sensitiveRow.test.tsx)', () => {
  it('Stage all names explicit paths and EXCLUDES the blocked ones', () => {
    expect(
      stageAllPaths([
        file({ path: 'src/app.ts' }),
        file({ path: '.env', is_sensitive: true }),
        file({ path: 'src/other.ts' })
      ])
    ).toEqual(['src/app.ts', 'src/other.ts'])
  })

  it('an all-blocked unstaged set yields NO paths, so the action has nothing to send', () => {
    expect(
      stageAllPaths([
        file({ path: '.env', is_sensitive: true }),
        file({ path: 'secrets.json', is_sensitive: true })
      ])
    ).toEqual([])
  })

  it('Stage all skips what is already staged', () => {
    expect(
      stageAllPaths([file({ path: 'a.ts', staged: true }), file({ path: 'b.ts', staged: false })])
    ).toEqual(['b.ts'])
  })

  it('Unstage all takes only the staged side, blocked paths excluded', () => {
    expect(
      unstageAllPaths([
        file({ path: 'a.ts', staged: true }),
        file({ path: '.env', staged: true, is_sensitive: true }),
        file({ path: 'b.ts', staged: false })
      ])
    ).toEqual(['a.ts'])
  })
})

describe("the group headers' bulk action", () => {
  it('unstages the Staged group and stages every other one', () => {
    expect(bulkLabelFor('staged')).toBe('Unstage all')
    expect(bulkLabelFor('unstaged')).toBe('Stage all')
    expect(bulkLabelFor('untracked')).toBe('Stage all')
    expect(bulkLabelFor('conflicted')).toBe('Stage all')
  })

  it('carries only the group it sits on — never the whole repo', () => {
    const groups = groupRows([
      file({ path: 'a.ts', staged: true }),
      file({ path: 'b.ts', staged: false }),
      file({ path: 'c.ts', status: 'untracked' })
    ])
    const paths = Object.fromEntries(groups.map((g) => [g.group, groupBulkPaths(g.rows)]))
    expect(paths).toEqual({ staged: ['a.ts'], unstaged: ['b.ts'], untracked: ['c.ts'] })
  })

  it('drops blocked rows, and an all-blocked group yields nothing to send', () => {
    const [group] = groupRows([
      file({ path: 'a.ts' }),
      file({ path: '.env', is_sensitive: true })
    ])
    expect(groupBulkPaths(group.rows)).toEqual(['a.ts'])
    const [blocked] = groupRows([file({ path: '.env', is_sensitive: true })])
    expect(groupBulkPaths(blocked.rows)).toEqual([])
  })

  it('names the group in the disabled reason', () => {
    expect(groupBulkDisabledReason('untracked')).toContain('Untracked')
    expect(groupBulkDisabledReason('untracked')).toContain('blocked path')
  })
})

describe('the PR line labels', () => {
  it('names every check state, and reads an unknown one as absence', () => {
    expect(prChecksLabel('running')).toBe('checks running')
    expect(prChecksLabel('failing')).toBe('checks failing')
    expect(prChecksLabel('passing')).toBe('checks passing')
    expect(prChecksLabel('none')).toBe('no checks')
    expect(prChecksLabel('teleported' as never)).toBe('no checks')
  })

  it('names the three review decisions, and returns null for anything else', () => {
    expect(prDecisionLabel('APPROVED')).toBe('approved')
    expect(prDecisionLabel('CHANGES_REQUESTED')).toBe('changes requested')
    expect(prDecisionLabel('REVIEW_REQUIRED')).toBe('review requested')
    expect(prDecisionLabel(null)).toBeNull()
    expect(prDecisionLabel('DISMISSED')).toBeNull()
  })
})

describe('the standalone Push button', () => {
  it('carries the ahead count, and drops it when there is none', () => {
    expect(pushLabel(2)).toBe('Push ↑2')
    expect(pushLabel(0)).toBe('Push')
  })

  it('is live with an upstream and something ahead', () => {
    expect(pushDisabledReason('origin/main', 2, false)).toBeNull()
  })

  it('stays live without an upstream, because the push publishes the branch', () => {
    expect(pushDisabledReason(null, 2, false)).toBeNull()
    expect(pushDisabledReason(null, 0, false)).toBeNull()
  })

  it('names what is missing rather than just disabling', () => {
    expect(pushDisabledReason('origin/main', 0, false)).toContain('Nothing to push')
    expect(pushDisabledReason('origin/main', 2, true)).toContain('Pushing')
  })
})

describe('pull disabled reason', () => {
  it('names the missing upstream, then a matching branch, then lets a real pull through', () => {
    expect(pullDisabledReason(null, 3)).toBe('This branch has no upstream yet')
    expect(pullDisabledReason('origin/main', 0)).toBe(
      'Nothing to pull — the branch matches its upstream'
    )
    expect(pullDisabledReason('origin/main', 2)).toBeNull()
  })
})
