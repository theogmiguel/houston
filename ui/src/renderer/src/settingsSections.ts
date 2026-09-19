export type SettingsGroupId = 'look' | 'agents' | 'data' | 'reference'

export type SettingsSectionId =
  | 'appearance'
  | 'terminal'
  | 'shortcuts'
  | 'notifications'
  | 'accounts'
  | 'agent-setup'
  | 'workspace-defaults'
  | 'orchestration'
  | 'headless-roles'
  | 'voice'
  | 'privacy'
  | 'usage'
  | 'diagnostics'
  | 'daemon'
  | 'about'

export type SettingsIconKey =
  | 'palette'
  | 'terminal'
  | 'keyboard'
  | 'bell'
  | 'user'
  | 'folder'
  | 'fork'
  | 'sparkles'
  | 'mic'
  | 'database'
  | 'chart'
  | 'target'
  | 'info'
  | 'wrench'
  | 'server'

export interface SettingsGroupDef {
  id: SettingsGroupId
  label: string
  quiet?: true
}

export interface SettingsSectionDef {
  id: SettingsSectionId
  label: string
  icon: SettingsIconKey
  group: SettingsGroupId
  keywords: string[]
  pending?: true
}

export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  { id: 'look', label: 'Look & feel' },
  { id: 'agents', label: 'Agents' },
  { id: 'data', label: 'Your data' },
  { id: 'reference', label: 'Reference', quiet: true }
] as const

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'palette',
    group: 'look',
    keywords: [
      'theme', 'chrome', 'dark', 'light', 'color', 'swatch', 'palette', 'zoom', 'motion',
      'sidebar', 'rail', 'hide', 'skills', 'routines', 'connections'
    ]
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: 'terminal',
    group: 'look',
    keywords: [
      'font', 'cursor', 'scrollback', 'ligatures', 'copy on select', 'bell', 'libghostty',
      'panes per stack', 'stack', 'tabs', 'idle quiet window', 'idle'
    ]
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: 'keyboard',
    group: 'look',
    keywords: ['keyboard', 'keybind', 'rebind', 'hotkey', 'keys', 'keymap', 'vim', 'emacs']
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    group: 'look',
    keywords: ['alerts', 'sound', 'chime', 'os notifications', 'needs input', 'turn complete']
  },
  {
    id: 'accounts',
    label: 'Accounts',
    icon: 'user',
    group: 'agents',
    keywords: [
      'claude_config_dir', 'codex_home', 'profile', 'profiles', 'isolation',
      'connect accounts', 'per-cli overrides', 'login'
    ]
  },
  {
    id: 'agent-setup',
    label: 'Agent setup',
    icon: 'wrench',
    group: 'agents',
    keywords: ['hooks', 'status', 'integration', 'setup', 'repair', 'working', 'needs input', 'claude', 'codex']
  },
  {
    id: 'workspace-defaults',
    label: 'Workspaces',
    icon: 'folder',
    group: 'agents',
    keywords: [
      'workspace defaults', 'restore budget',
      'open links', 'browser pane', 'idle', 'background sessions',
      'close idle', 'reap'
    ]
  },
  {
    id: 'orchestration',
    label: 'Orchestration',
    icon: 'fork',
    group: 'agents',
    keywords: [
      'spawn', 'spawning', 'agent spawns agent', 'children', 'child panes', 'depth',
      'hs-pane', 'caps', 'mailbox'
    ]
  },
  {
    id: 'headless-roles',
    label: "Houston's own agents",
    icon: 'sparkles',
    group: 'agents',
    keywords: [
      'writer', 'write with ai', 'commit message', 'pull request', 'headless',
      'engine', 'model'
    ]
  },
  {
    id: 'voice',
    label: 'Dictation',
    icon: 'mic',
    group: 'agents',
    keywords: [
      'dictation', 'voice', 'speech', 'microphone', 'whisper', 'transcribe', 'stt', 'push to talk',
      'language'
    ]
  },
  {
    id: 'privacy',
    label: 'Privacy & data',
    icon: 'database',
    group: 'data',
    keywords: ['telemetry', 'history', 'ignore patterns', 'browsing data', 'session database', 'transcripts', 'clear']
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: 'chart',
    group: 'data',
    keywords: [
      'tokens', 'cost', 'spend', 'billing', 'cache savings', 'models', 'transcripts',
      'ccusage', 'rates', 'litellm', 'claude code', 'codex'
    ]
  },
  {
    id: 'daemon',
    label: 'Daemon',
    icon: 'server',
    group: 'data',
    keywords: [
      'background process', 'detach', 'stop daemon', 'running since', 'reap', 'exit',
      'live sessions', 'routines armed', 'clients connected', 'quit'
    ]
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    icon: 'target',
    group: 'reference',
    keywords: ['channel', 'state directory', 'pid', 'port', 'protocol version', 'uptime', 'mailbox files', 'hooks wired', 'logs']
  },
  {
    id: 'about',
    label: 'About',
    icon: 'info',
    group: 'reference',
    keywords: ['version', 'build', 'third-party notices', 'release notes', 'licences']
  }
] as const

export const NAVIGABLE_SETTINGS_SECTIONS: readonly SettingsSectionDef[] =
  SETTINGS_SECTIONS.filter((s) => !s.pending)
