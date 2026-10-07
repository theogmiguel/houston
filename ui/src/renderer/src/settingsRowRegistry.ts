import { SETTINGS_SECTIONS, type SettingsSectionDef, type SettingsSectionId } from './settingsSections'

export const SETTINGS_ROW_REGISTRY: Partial<Record<SettingsSectionId, readonly string[]>> = {
  appearance: ['Background', 'Skills', 'Routines', 'Connections', 'Open diff when an agent stops', 'App zoom'],
  terminal: ['Palette', 'Font size', 'Font family', 'Line height', 'Cursor blink', 'Scrollback', 'Shell integration', 'Shift+Enter inserts a newline', 'Clipboard access', 'Copy on select', 'Copy the text, not the box', 'Panes per stack', 'Idle quiet window'],
  shortcuts: ['Enable shortcuts', 'Pass through to terminal'],
  agents: ['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Grok', 'Active profile', 'Saved profiles', 'Add profile'],
  workspaces: ['Restore budget', 'Resume conversations when restoring panes', 'Remove worktrees automatically', 'Grace after merge', 'Remove idle worktrees after', 'Close idle background sessions', 'Idle for', 'Open links in a browser pane'],
  orchestration: ['Max child panes per agent', 'Max nesting depth', 'Enable orchestration', 'Mailbox retention'],
  tasks: ['Agent access', 'Task key prefix'],
  notifications: ['Desktop notifications', 'In-app notifications'],
  dictation: ['Groq API key', 'Enable dictation', 'Engine', 'Output', 'Tell the agent it is a translation', 'Activation', 'Dictation key', 'Microphone', 'Input device', 'Spoken language', 'Insertion', 'Vocabulary'],
  privacy: ['Command history', 'History ignore patterns', 'Browser pane data', 'Session database', 'Telemetry', 'Agent transcripts'],
  daemon: ['Keep Houston in the tray when the window closes', 'Stop daemon', 'Copy diagnostics', 'Daemon logs'],
  about: ['Houston', 'Contact', 'License', 'Third-party notices', 'Updates', 'Check for updates']
}

export interface SettingsRowSearchHit {
  section: SettingsSectionDef
  title: string
}

export function searchSettingsRows(query: string): SettingsRowSearchHit[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  return SETTINGS_SECTIONS.flatMap((section) =>
    (SETTINGS_ROW_REGISTRY[section.id] ?? [])
      .map((title) => ({ section, title }))
      .filter(({ title }) => title.toLocaleLowerCase().includes(needle) || section.label.toLocaleLowerCase().includes(needle) || section.keywords.some((keyword) => keyword.toLocaleLowerCase().includes(needle)))
      .map((hit) => ({ ...hit, rank: rowSearchRank(hit.title, section, needle) }))
  )
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
    .map(({ section, title }) => ({ section, title }))
}

function rowSearchRank(title: string, section: SettingsSectionDef, needle: string): number {
  const row = title.toLocaleLowerCase()
  if (row === needle) return 0
  if (row.startsWith(needle)) return 1
  if (row.split(/\s+/).some((word) => word.startsWith(needle))) return 2
  if (row.includes(needle)) return 3
  if (section.label.toLocaleLowerCase().includes(needle)) return 4
  return 5
}
