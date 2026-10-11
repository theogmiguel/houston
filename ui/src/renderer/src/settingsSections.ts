export type SettingsSectionId =
  | 'appearance'
  | 'mascot'
  | 'terminal'
  | 'shortcuts'
  | 'agents'
  | 'notifications'
  | 'workspaces'
  | 'orchestration'
  | 'tasks'
  | 'dictation'
  | 'privacy'
  | 'daemon'
  | 'wsl'
  | 'about'

export type SettingsIconKey =
  | 'palette'
  | 'terminal'
  | 'keyboard'
  | 'user'
  | 'bell'
  | 'folder'
  | 'fork'
  | 'tasks'
  | 'mic'
  | 'database'
  | 'info'
  | 'server'

export interface SettingsSectionDef {
  id: SettingsSectionId
  label: string
  icon: SettingsIconKey
  keywords: string[]
  pending?: true
}

const ALL_SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'appearance', label: 'Appearance', icon: 'palette', keywords: ['theme', 'chrome', 'dark', 'light', 'color', 'palette', 'zoom', 'motion', 'background'] },
  { id: 'mascot', label: 'Mascot', icon: 'user', keywords: ['mascot', 'companion', 'buddy', 'hat', 'holidays', 'pixel', 'colors', 'floating', 'rail', 'sounds', 'nap', 'break'] },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', keywords: ['font', 'cursor', 'scrollback', 'ligatures', 'copy', 'bell', 'stack', 'tabs', 'idle'] },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', keywords: ['keyboard', 'keybind', 'rebind', 'hotkey', 'keys', 'keymap', 'vim', 'emacs'] },
  { id: 'agents', label: 'Agents', icon: 'user', keywords: ['accounts', 'profiles', 'hooks', 'status', 'setup', 'integration', 'login', 'claude', 'codex'] },
  { id: 'notifications', label: 'Notifications', icon: 'bell', keywords: ['desktop', 'desktop notifications', 'in-app', 'in-app notices', 'sound', 'taskbar', 'finished', 'needs input'] },
  { id: 'workspaces', label: 'Workspaces', icon: 'folder', keywords: ['workspace defaults', 'restore budget', 'open links', 'browser pane', 'background sessions', 'close idle', 'reap'] },
  { id: 'orchestration', label: 'Orchestration', icon: 'fork', keywords: ['spawn', 'children', 'child panes', 'depth', 'hs-pane', 'caps', 'mailbox'] },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', keywords: ['backlog', 'task', 'access', 'read only', 'agent access', 'todo', 'key prefix'] },
  { id: 'dictation', label: 'Dictation', icon: 'mic', keywords: ['dictation', 'voice', 'speech', 'microphone', 'whisper', 'transcribe', 'stt', 'push to talk', 'language'] },
  { id: 'privacy', label: 'Privacy & data', icon: 'database', keywords: ['telemetry', 'history', 'ignore patterns', 'browsing data', 'session database', 'transcripts', 'clear'] },
  { id: 'daemon', label: 'Daemon', icon: 'server', keywords: ['diagnostics', 'channel', 'state directory', 'pid', 'port', 'protocol version', 'uptime', 'logs', 'stop daemon', 'live sessions'] },
  { id: 'wsl', label: 'WSL', icon: 'server', keywords: ['wsl', 'linux', 'distro', 'ubuntu', 'environment', 'experimental'] },
  { id: 'about', label: 'About', icon: 'info', keywords: ['version', 'build', 'third-party notices', 'release notes', 'licences'] }
] as const

/** WSL environments exist only on Windows, so the section is listed only there. */
export function settingsSectionsFor(platform: string): readonly SettingsSectionDef[] {
  return platform.startsWith('Win') ? ALL_SETTINGS_SECTIONS : ALL_SETTINGS_SECTIONS.filter((s) => s.id !== 'wsl')
}

export const SETTINGS_SECTIONS = settingsSectionsFor(typeof navigator === 'undefined' ? '' : navigator.platform)

export const NAVIGABLE_SETTINGS_SECTIONS = SETTINGS_SECTIONS

export const LEGACY_SETTINGS_SECTION: Readonly<Record<string, SettingsSectionId>> = {
  accounts: 'agents',
  'agent-setup': 'agents',
  'workspace-defaults': 'workspaces',
  voice: 'dictation',
  diagnostics: 'daemon'
}
