import type { SettingsSectionId } from './settingsSections'

export const SETTINGS_ROW_REGISTRY: Partial<Record<SettingsSectionId, readonly string[]>> = {
  appearance: ['Background', 'Palette', 'Skills', 'Routines', 'Connections', 'App zoom'],
  terminal: [
    'Font size',
    'Font family',
    'Line height',
    'Cursor blink',
    'Scrollback',
    'Shell integration',
    'Shift+Enter inserts a newline',
    'Clipboard access',
    'Copy on select',
    'Copy the text, not the box',
    'Panes per stack',
    'Idle quiet window'
  ],
  shortcuts: ['Enable shortcuts', 'Pass through to terminal'],
  notifications: ['Desktop notifications', 'Play sound', 'Blocked by the OS'],
  'workspace-defaults': [
    'Restore budget',
    'Close idle background sessions',
    'Idle for',
    'Open links in a browser pane'
  ],
  orchestration: [
    'Max child panes per agent',
    'Max nesting depth',
    'Enable orchestration',
    'Mailbox retention'
  ],
  voice: [
    'Groq API key',
    'Enable dictation',
    'Engine',
    'Output',
    'Tell the agent it is a translation',
    'Activation',
    'Dictation key',
    'Microphone',
    'Input device',
    'Spoken language',
    'Insertion',
    'Vocabulary'
  ],
  privacy: [
    'Command history',
    'History ignore patterns',
    'Browser pane data',
    'Session database',
    'Telemetry',
    'Agent transcripts'
  ],
  daemon: ['Keep Houston in the tray when the window closes', 'Stop daemon'],
  diagnostics: ['Copy diagnostics', 'Daemon logs'],
  about: ['Houston', 'Contact', 'License', 'Third-party notices', 'Updates', 'Check for updates']
}
