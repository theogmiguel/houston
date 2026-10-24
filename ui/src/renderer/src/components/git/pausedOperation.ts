import type { GitOperation } from '../../houston/generated/GitOperation'

const COMMAND: Record<GitOperation, string> = {
  merge: 'merge',
  rebase: 'rebase',
  cherry_pick: 'cherry-pick'
}

// A brief lists at most this many paths; the agent reads the rest from `git status`.
const MAX_LISTED_PATHS = 50

export function pausedOperationLabel(operation: GitOperation): string {
  return COMMAND[operation]
}

export function pausedOperationBanner(operation: GitOperation, conflicted: number): string {
  const files = conflicted === 1 ? '1 conflicted file' : `${conflicted} conflicted files`
  return conflicted > 0
    ? `A ${COMMAND[operation]} is paused here with ${files}.`
    : `A ${COMMAND[operation]} is paused here.`
}

export interface ResolveBriefInput {
  operation: GitOperation
  dir: string
  branch: string | null
  conflicted: string[]
}

// Composed from the git state the daemon reported; nothing is read from a terminal.
export function buildResolveBrief({ operation, dir, branch, conflicted }: ResolveBriefInput): string {
  const op = COMMAND[operation]
  const where = branch ? `${dir} (branch ${branch})` : dir
  const listed = conflicted.slice(0, MAX_LISTED_PATHS).map((path) => `- ${path}`)
  if (conflicted.length > MAX_LISTED_PATHS) listed.push(`- and ${conflicted.length - MAX_LISTED_PATHS} more; see git status`)
  const files = conflicted.length > 0
    ? [`Conflicted files (${conflicted.length}):`, ...listed]
    : ['Git reports no conflicted file, so the operation stopped for another reason (a failing hook, a commit to edit, an empty commit). Find out which with `git status`.']
  const skip = operation === 'merge' ? '' : ` If a commit becomes empty once resolved, \`git ${op} --skip\` drops it.`
  return [
    `A git ${op} is paused in ${where}. Finish it.`,
    '',
    ...files,
    '',
    'Steps:',
    '1. If the git dir holds an index.lock, another git command may still be running: wait and look again; never delete the lock.',
    '2. Resolve each conflict with the smallest edit that keeps the intent of both sides, then `git add` the file.',
    '3. Run `git diff --check` and fix every conflict marker or whitespace error it reports.',
    `4. Run \`git ${op} --continue\`.${skip} Repeat until git reports the ${op} is complete.`,
    '',
    'Rules:',
    `- Never run \`git reset --hard\`, \`git stash\` or \`git ${op} --abort\`. If a conflict cannot be resolved safely, stop and say why.`,
    '- Do not edit files the operation did not touch.',
    '',
    `Report back: the files you resolved and how, the output of \`git diff --check\`, and whether the ${op} completed or why it is still paused.`
  ].join('\n')
}
