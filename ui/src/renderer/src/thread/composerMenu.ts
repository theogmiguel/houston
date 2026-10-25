import type { ThreadCommands } from './threadTypes'

/** The `/` or `@` word the caret is in: `start` is the trigger's index, `end` the caret. */
export interface MenuToken {
  trigger: '/' | '@'
  query: string
  start: number
  end: number
}

/** The menu word under the caret: `/` only at the message start (Claude runs a command only there), `@` at any word start. */
export function menuToken(text: string, caret: number): MenuToken | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1] ?? '')) start -= 1
  const trigger = text[start]
  if (trigger !== '/' && trigger !== '@') return null
  if (trigger === '/' && start !== 0) return null
  return { trigger, query: text.slice(start + 1, caret), start, end: caret }
}

/** Replaces the token with `insert` and a space; returns the text and where the caret goes. */
export function insertAtToken(text: string, token: MenuToken, insert: string): { text: string; caret: number } {
  const after = text.slice(token.end).replace(/^\S*/, '')
  const spaced = after.startsWith(' ') ? insert : `${insert} `
  const next = text.slice(0, token.start) + spaced + after
  return { text: next, caret: token.start + spaced.length + (after.startsWith(' ') ? 1 : 0) }
}

/** Claude reads `@path`; a path with spaces is quoted so the mention ends where the path does. */
export function atMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

export type SlashGroup = 'houston' | 'skill' | 'claude' | 'terminal'

export interface SlashRow {
  group: SlashGroup
  name: string
}

export const SLASH_GROUP_LABEL: Record<SlashGroup, string> = {
  houston: 'Houston',
  skill: 'Skills',
  claude: 'Claude',
  terminal: 'Terminal only'
}

/** Houston's own command: the existing view switch. */
export const OPEN_IN_TERMINAL = 'terminal'

/** Rows shown for one query; more would not fit the menu and filtering narrows them. */
export const SLASH_ROWS_MAX = 40

function matches(name: string, query: string): number {
  const at = name.toLowerCase().indexOf(query.toLowerCase())
  return at < 0 ? -1 : at === 0 ? 0 : 1
}

/** The rows for `query` in menu order: Houston, Skills, Claude, then Terminal only; prefix matches first in each group. */
export function slashRows(commands: ThreadCommands | null, query: string): SlashRow[] {
  const groups: [SlashGroup, readonly string[]][] = [
    ['houston', [OPEN_IN_TERMINAL]],
    ['skill', commands?.skills ?? []],
    ['claude', commands?.commands ?? []],
    ['terminal', commands?.terminal_only ?? []]
  ]
  const rows: SlashRow[] = []
  for (const [group, names] of groups) {
    const ranked = names
      .map((name) => ({ name, rank: matches(name, query) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
    for (const { name } of ranked) rows.push({ group, name })
  }
  return rows.slice(0, SLASH_ROWS_MAX)
}
