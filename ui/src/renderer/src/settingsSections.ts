export type SettingsSectionId =
  | 'appearance'
  | 'terminal'
  | 'shortcuts'
  | 'agents-overview'
  | 'agents-clis'
  | 'agents-skills'
  | 'agents-mcp'
  | 'agents-review'
  | 'notifications'
  | 'workspaces'
  | 'orchestration'
  | 'tasks'
  | 'dictation'
  | 'privacy'
  | 'daemon'
  | 'wsl'
  | 'remote'
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
  | 'phone'
  | 'compass'
  | 'sparkles'
  | 'plug'
  | 'history'

export interface SettingsSectionDef {
  id: SettingsSectionId
  label: string
  icon: SettingsIconKey
  group: 'agents' | 'app' | 'work' | 'devices' | 'system'
  width?: 'wide'
  keywords: string[]
  pending?: true
}

const ALL_SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'agents-overview', label: 'Overview', icon: 'compass', group: 'agents', width: 'wide', keywords: ['agents', 'setup', 'attention', 'status'] },
  { id: 'agents-clis', label: 'CLIs', icon: 'terminal', group: 'agents', width: 'wide', keywords: ['agents', 'accounts', 'profiles', 'hooks', 'status', 'setup', 'login', 'claude', 'codex'] },
  { id: 'agents-skills', label: 'Skills', icon: 'sparkles', group: 'agents', width: 'wide', keywords: ['skills', 'library', 'commands', 'sync', 'copies'] },
  { id: 'agents-mcp', label: 'MCP servers', icon: 'plug', group: 'agents', width: 'wide', keywords: ['mcp', 'servers', 'plugins', 'connections'] },
  { id: 'agents-review', label: 'Review', icon: 'history', group: 'agents', width: 'wide', keywords: ['review', 'harness', 'findings', 'mistakes', 'sessions'] },
  { id: 'appearance', label: 'Appearance', icon: 'palette', group: 'app', keywords: ['theme', 'chrome', 'dark', 'light', 'color', 'palette', 'zoom', 'motion', 'background', 'pixel', 'colors', 'rail', 'mascot', 'companion', 'buddy', 'hat', 'holidays', 'floating', 'sounds', 'nap', 'break'] },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', group: 'app', keywords: ['font', 'cursor', 'scrollback', 'ligatures', 'copy', 'bell', 'stack', 'tabs', 'idle'] },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', group: 'app', keywords: ['keyboard', 'keybind', 'rebind', 'hotkey', 'keys', 'keymap', 'vim', 'emacs'] },
  { id: 'notifications', label: 'Notifications', icon: 'bell', group: 'app', keywords: ['desktop', 'desktop notifications', 'in-app', 'in-app notices', 'sound', 'taskbar', 'finished', 'needs input'] },
  { id: 'workspaces', label: 'Workspaces', icon: 'folder', group: 'work', keywords: ['workspace defaults', 'restore budget', 'open links', 'browser pane', 'background sessions', 'close idle', 'reap'] },
  { id: 'orchestration', label: 'Orchestration', icon: 'fork', group: 'work', keywords: ['spawn', 'children', 'child panes', 'depth', 'hs-pane', 'caps', 'mailbox'] },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', group: 'work', keywords: ['backlog', 'task', 'access', 'read only', 'agent access', 'todo', 'key prefix'] },
  { id: 'dictation', label: 'Dictation', icon: 'mic', group: 'work', keywords: ['dictation', 'voice', 'speech', 'microphone', 'whisper', 'transcribe', 'stt', 'push to talk', 'language'] },
  { id: 'privacy', label: 'Privacy & data', icon: 'database', group: 'system', keywords: ['telemetry', 'history', 'ignore patterns', 'browsing data', 'session database', 'transcripts', 'clear'] },
  { id: 'daemon', label: 'Daemon', icon: 'server', group: 'system', keywords: ['diagnostics', 'channel', 'state directory', 'pid', 'port', 'protocol version', 'uptime', 'logs', 'stop daemon', 'live sessions'] },
  { id: 'wsl', label: 'WSL', icon: 'server', group: 'system', keywords: ['wsl', 'linux', 'distro', 'ubuntu', 'environment', 'experimental'] },
  { id: 'remote', label: 'Phone & remote access', icon: 'phone', group: 'devices', keywords: ['phone', 'mobile', 'remote', 'pair', 'device', 'tailscale', 'ntfy', 'push', 'qr', 'revoke', 'another computer', 'certificate', 'https', 'dictation'] },
  { id: 'about', label: 'About', icon: 'info', group: 'system', keywords: ['version', 'build', 'third-party notices', 'release notes', 'licences'] }
] as const

/** WSL environments exist only on Windows, so the section is listed only there. */
export function settingsSectionsFor(platform: string): readonly SettingsSectionDef[] {
  const groups = ['agents', 'app', 'work', 'devices', 'system']
  return ALL_SETTINGS_SECTIONS.filter((s) => platform.startsWith('Win') || s.id !== 'wsl').sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group))
}

export const SETTINGS_SECTIONS = settingsSectionsFor(typeof navigator === 'undefined' ? '' : navigator.platform)

export const NAVIGABLE_SETTINGS_SECTIONS = SETTINGS_SECTIONS

export const LEGACY_SETTINGS_SECTION: Readonly<Record<string, SettingsSectionId>> = {
  agents: 'agents-clis',
  accounts: 'agents-clis',
  mascot: 'appearance',
  'agent-setup': 'agents-clis',
  'workspace-defaults': 'workspaces',
  voice: 'dictation',
  diagnostics: 'daemon'
}
