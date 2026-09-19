import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ServerMsg } from '../src/renderer/src/houston/generated/ServerMsg'
import { PROTOCOL_VERSION } from '../src/renderer/src/houston/generated/PROTOCOL_VERSION'
import { App } from '../src/renderer/src/App'
import { BTN_PRIMARY } from '../src/renderer/src/components/buttonChrome'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { LayoutView } from '../src/renderer/src/components/LayoutView'
import type { LayoutNode } from '../src/renderer/src/layout/tree'
import { SettingsView } from '../src/renderer/src/components/SettingsView'
import { ShortcutSheet } from '../src/renderer/src/components/ShortcutSheet'
import { PaneHandoff } from '../src/renderer/src/components/PaneHandoff'
import { HandoffOverlay, type HandoffUiState } from '../src/renderer/src/components/HandoffOverlay'
import { AnimOut } from '../src/renderer/src/components/AnimOut'
import { ConfirmModal } from '../src/renderer/src/components/ConfirmModal'
import { HostKeyModal, type HostKeyPrompt } from '../src/renderer/src/components/HostKeyModal'
import { SshConnectModal } from '../src/renderer/src/components/SshConnectModal'
import type { SshProfile } from '../src/renderer/src/houston/generated/SshProfile'
import type { HoustonClient as HoustonClientType } from '../src/renderer/src/houston/client'
import type { HandoffUi } from '../src/renderer/src/components/HandoffOverlay'
import type { SwarmInfo } from '../src/renderer/src/houston/generated/SwarmInfo'
import {
  TerminalPane as RealTerminalPane,
  type OutputSink,
  type RegisterOutput,
  type TermActions
} from '../src/renderer/src/pane/TerminalPane.tsx'
import type { AgentKind, AgentStatus, SessionInfo } from '../src/renderer/src/houston/client'
import type { ThemeName } from '../src/renderer/src/theme'
import { deliverToApp, installHarnessBridge, makeTerminalPaneClient } from './StubHoustonClient'
import oldCss from './old-full.css?raw'
import { injectOldSheet } from './scopeOld'
import props from './props.json'
import '../src/renderer/src/tailwind.css'
import '../src/renderer/src/theme.css'
import '../src/renderer/src/base.css'
import '../src/renderer/src/global.css'

injectOldSheet(oldCss)

if (new URLSearchParams(location.search).has('freeze')) {
  const f = document.createElement('style')
  f.id = 'harness-freeze'
  f.textContent = `*,*::before,*::after{animation:none!important;transition:none!important}`
  document.head.appendChild(f)
}

const FROZEN_NOW = 1754001000000
Date.now = () => FROZEN_NOW

{
  const REAL_SET_TIMEOUT = window.setTimeout.bind(window)
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 170 || timeout === 560 || timeout === 3000 || timeout === 2500) {
      return REAL_SET_TIMEOUT(() => {}, 2 ** 31 - 1)
    }
    return REAL_SET_TIMEOUT(handler as never, timeout, ...args)
  }) as typeof window.setTimeout
}

const FIXTURE_DIR_ROOT = '/home/dev/houston'
const FIXTURE_DIRS: Record<string, { name: string; dir: boolean }[]> = {
  [FIXTURE_DIR_ROOT]: [
    { name: 'src', dir: true },
    { name: 'README.md', dir: false },
    { name: 'broken.txt', dir: false }
  ],
  [`${FIXTURE_DIR_ROOT}/src`]: [{ name: 'index.ts', dir: false }]
}
const FIXTURE_FILES: Record<string, string> = {
  [`${FIXTURE_DIR_ROOT}/README.md`]: '# Houston\n\nFixture file for the P5 Wave B harness.\n',
  [`${FIXTURE_DIR_ROOT}/src/index.ts`]: "export const fixture = 'p5-harness'\n"
}

const notImplemented = (name: string) => (): never => {
  throw new Error(`window.houston.${name} is not stubbed in the P5 shard 19 harness`)
}
window.houston = {
  getConfig: notImplemented('getConfig'),
  pickDirectory: notImplemented('pickDirectory'),
  windowControl: () => {},
  isFocused: () => Promise.resolve(true),
  setZoomFactor: () => {},
  saveImage: notImplemented('saveImage'),
  saveReview: notImplemented('saveReview'),
  openExternal: () => {},
  listSkills: () => Promise.resolve([]),
  writeSkill: notImplemented('writeSkill'),
  deleteSkill: notImplemented('deleteSkill'),
  readDir: (dir: string) =>
    Promise.resolve(
      (FIXTURE_DIRS[dir] ?? []).map((e) => ({ name: e.name, path: `${dir}/${e.name}`, dir: e.dir, ignored: false }))
    ),
  readFile: (path: string) =>
    path in FIXTURE_FILES
      ? Promise.resolve(FIXTURE_FILES[path])
      : Promise.reject(new Error(`p5-harness readFile: no fixture content for ${JSON.stringify(path)}`)),
  writeFile: () => Promise.resolve(),
  statFile: () => Promise.resolve({ mtimeMs: FROZEN_NOW }),
  pathKind: notImplemented('pathKind'),
  pickerListDirs: notImplemented('pickerListDirs'),
  homeDir: () => Promise.resolve('/home/dev'),
  pickFile: () => Promise.resolve(`${FIXTURE_DIR_ROOT}/README.md`),
  getPathForFile: () => '',
  openPath: () => Promise.resolve({ ok: true }),
  listShells: () => Promise.resolve([]),
  getLogsDir: () => Promise.resolve('/home/dev/.houston/logs'),
  setBackgroundColor: () => {},
  setAllowedRoots: () => {}
} as unknown as Window['houston']

installHarnessBridge()

const WORKSPACES = props.workspaces as { path: string; name: string }[]
const SESSIONS = props.sessions as Array<{
  id: number
  agent: string
  project_dir: string
  cwd: string
  state: string
  title: string
  hidden: boolean
  ssh_host?: string
  restore_deferred?: string
  status?: string
}>

const helloOk = (): ServerMsg => ({
  type: 'hello_ok',
  protocol: PROTOCOL_VERSION,
  sessions: SESSIONS as never,
  workspaces: WORKSPACES,
  tags: [],
  safe_mode: { disable_auto_restore: false, disable_swarm_autolaunch: false },
  snapshot_attach: false,
  snapshot_format_version: 0
})

function resetSingletons(): void {
  localStorage.clear()
}

const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

const TERMINAL_INFO: SessionInfo = {
  id: SESSIONS[0].id,
  agent: SESSIONS[0].agent as AgentKind,
  project_dir: SESSIONS[0].project_dir,
  cwd: SESSIONS[0].cwd,
  state: SESSIONS[0].state as SessionInfo['state'],
  title: SESSIONS[0].title,
  codename: SESSIONS[0].title,
  hidden: SESSIONS[0].hidden,
  live_children: 0,
  children_waiting: 0,
  inbox_unread: 0,
  tags: [],
}
const TERMINAL_THEME: ThemeName = 'warm-espresso'
const TERMINAL_FONT_SIZE = 13

const HANDOFF_STATE: HandoffUiState = {
  request: 1,
  session: TERMINAL_INFO.id,
  sessionTitle: TERMINAL_INFO.title,
  provider: 'claude',
  phase: 'done',
  text: '',
  markdown: '## Handoff summary\n\nFixture markdown for the P5 shard 20 harness.',
  savedPath: '',
  error: ''
}

const CONFIRM_MSG = 'Close 3 sessions in this workspace? Running agents will be interrupted.'

const SSH_PROFILES: SshProfile[] = [
  {
    name: 'edge-01',
    user: 'dev',
    host: 'edge-01.example.internal',
    port: 22,
    auth: { kind: 'agent' },
    default_dir: '/srv/edge',
    startup_cmd: 'tmux attach',
    last_used_at: 1755300000,
    has_credential: false
  },
  {
    name: 'build-box',
    user: 'ci',
    host: 'build.example.internal',
    port: 2222,
    auth: { kind: 'identity_file', path: '/home/dev/.ssh/id_ed25519' },
    default_dir: null,
    startup_cmd: null,
    last_used_at: null,
    has_credential: true
  }
]

const HOSTKEY_PROMPT: HostKeyPrompt = {
  request: 1,
  host: 'build.example.internal',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:qP8mJ2xR7vK1nL4tB6wC9yF3sD5hG0aE8uI2oN7pM4k',
  randomart: [
    '+--[ED25519 256]--+',
    '|      .o+*=o     |',
    '|     . o+=.o     |',
    '|      o o+. .    |',
    '|     . = .o      |',
    '|      o S .      |',
    '+----[SHA256]-----+'
  ].join('\n'),
  changed: false
}

type ModalKind = 'confirm' | 'hostkey' | 'ssh'

function ModalBody({ kind }: { kind: ModalKind }): React.JSX.Element | null {
  switch (kind) {
    case 'confirm':
      return <ConfirmModal message={CONFIRM_MSG} confirmLabel="Close all" onConfirm={() => {}} onCancel={() => {}} />
    case 'hostkey':
      return <HostKeyModal prompt={HOSTKEY_PROMPT} onAnswer={() => {}} remaining={2} onRejectRemaining={() => {}} />
    case 'ssh':
      return (
        <SshConnectModal
          profiles={SSH_PROFILES}
          initial={null}
          onConnect={() => {}}
          onSaveProfile={() => {}}
          onDeleteProfile={() => {}}
          onClose={() => {}}
        />
      )
  }
}

function ModalHost({
  kind,
  closing
}: {
  kind: ModalKind
  closing: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (closing) setOpen(false)
  }, [closing])
  return (
    <AnimOut open={open}>
      <ModalBody kind={kind} />
    </AnimOut>
  )
}

const settingsProps: Parameters<typeof SettingsView>[0] = {
  update: null,
  onUpdateCheckNow: () => {},
  onUpdatePolicySet: () => {},
  onOpenExternal: () => {},
  usage: null,
  usageLoading: false,
  usageError: null,
  onUsageRequest: () => {},
  voiceSettings: null,
  voiceCloudKeyPresent: false,
  voiceKeyringError: null,
  voiceModels: [],
  voiceDevices: [],
  onVoiceSettingsSet: () => {},
  onVoiceKeySet: () => {},
  onVoiceKeyClear: () => {},
  onVoiceDevicesRefresh: () => {},
  onVoiceModelDownload: () => {},
  onVoiceModelDelete: () => {},
  historyIgnoreGlobs: null,
  headlessWriter: null,
  onHeadlessRoleSet: () => {},
  onHistoryIgnoreGlobsSet: () => {},
  onOpenLicense: () => {},
  onRestoreBudgetSet: () => {},
  sessionPolicy: null,
  onSessionPolicy: () => {},
  orchestrationEnabled: true,
  onOrchestrationEnabled: () => {},
  onOrchestrationCapsSet: () => {},
  onMailboxRetentionSet: () => {},
  hostInfo: null,
  agentHooks: null,
  onOpenHooks: () => {},
    onAgentHooksSet: () => {},
    onAgentHooksRefresh: () => {},
  onRevealSessionDb: () => {},
  onVoiceLevelMonitor: () => {},
  agentProfiles: null,
  onAgentProfileUpsert: () => {},
  onAgentProfileDelete: () => {},
  onAgentProfileSetActive: () => {},
  chromeTheme: 'graphite',
  onChromeTheme: () => {},
  theme: 'warm-espresso',
  onTheme: () => {},
  shellIntegration: false,
  onShellIntegration: () => {},
  osc52: true,
  onOsc52: () => {},
  copyOnSelect: true,
  onCopyOnSelect: () => {},
  stripBoxGlyphs: false,
  onStripBoxGlyphs: () => {},
  fontSize: 14,
  onFontSize: () => {},
  fontMin: 8,
  fontMax: 24,
  fontDefault: 14,
  fontFamilyId: 'nerd',
  shiftEnterNewline: true,
  openLinksInPane: false,
  notifyKinds: { completed: true, error: true, 'needs-input': true, info: true },
  onNotifyKinds: () => {},
  onOpenLinksInPane: () => {},
  onShiftEnterNewline: () => {},
  onFontFamilyId: () => {},
  uiZoom: 1,
  onUiZoom: () => {},
  zoomMin: 0.5,
  zoomMax: 2,
  zoomStep: 0.1,
  orchestrationState: null,
  onOpenAcpPane: () => {},
  historyWorkspace: null,
  historyWorkspaceName: null,
  historyCount: null,
  onClearHistory: () => {},
  onOpenLogsFolder: () => {},
  keymapOverrides: { bindings: {}, shortcuts_enabled: true },
  onKeymapOverrides: () => {},
  notifyEnabled: true,
  onNotifyEnabled: () => {},
  notifySound: false,
  onNotifySound: () => {},
  onNotifyPreview: () => {},
  onContact: () => {}
}

const sidebarFixtureProps: Parameters<typeof Sidebar>[0] = {
  workspaces: WORKSPACES,
  sessions: SESSIONS as unknown as SessionInfo[],
  selected: WORKSPACES[0].path,
  customColors: {},
  colorIndexByPath: Object.fromEntries(WORKSPACES.map((w, i) => [w.path, i])),
  unreadByWs: {},
  renaming: null,
  onSelect: () => {},
  onAddWorkspace: () => {},
  onRemoveWorkspace: () => {},
  onRenameStart: () => {},
  onRenameSubmit: () => {},
  onRenameCancel: () => {},
  onChangeColor: () => {},
  onReorderWorkspace: () => {},
    pinnedWorkspaces: new Set(),
    onTogglePinWorkspace: () => {},
  onSshConnect: () => {},
  chromeTheme: 'graphite',
  onToggleChromeTheme: () => {}
}

const sessionPaneClient = makeTerminalPaneClient()
const SP_INFO_BASE: SessionInfo = {
  id: 101,
  agent: 'claude' as AgentKind,
  project_dir: '/home/dev/houston',
  cwd: '/home/dev/houston',
  state: 'running',
  title: 'Amber Falcon',
  codename: 'Amber Falcon',
  hidden: false,
  live_children: 0,
  children_waiting: 0,
  inbox_unread: 0,
  tags: [],
}

const SP_HANDOFF_STATE: HandoffUiState = { ...HANDOFF_STATE, session: SP_INFO_BASE.id }

function sessionPaneFixtureProps(v: {
  state?: SessionInfo['state']
  status?: AgentStatus
  expanded?: boolean
  active?: boolean
  showProject?: boolean
}): Parameters<typeof SessionPane>[0] {
  return {
    client: sessionPaneClient,
    info: { ...SP_INFO_BASE, state: v.state ?? 'running', status: v.status },
    theme: 'warm-espresso',
    active: !!v.active,
    connected: true,
    fontSize: 13,
    copyOnSelect: false,
    stripBoxGlyphs: false,
    showProject: !!v.showProject,
    registerOutput: () => () => {},
    shellIntegration: true,
    onReconnectSsh: () => {},
    onActivate: () => {},
    expanded: !!v.expanded,
    onExpand: () => {},
    onZoom: () => {},
    onShellZoom: () => {},
    onSplit: () => {},
    onHeaderPointerDown: () => {},
    onHandoff: () => {},
    onOpenFile: () => {},
    onOpenDir: () => {}
  }
}

function SessionPaneHandoffHost({
  props,
  closing
}: {
  props: Parameters<typeof SessionPane>[0]
  closing: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (closing) setOpen(false)
  }, [closing])
  return (
    <>
      <SessionPane {...props} />
      <AnimOut open={open}>
        {open && (
          <HandoffOverlay
            state={SP_HANDOFF_STATE}
            onCancel={() => {}}
            onClose={() => {}}
            onPaste={() => {}}
          />
        )}
      </AnimOut>
    </>
  )
}

const LAYOUT_TREE: LayoutNode = {
  kind: 'split',
  dir: 'row',
  weights: [50, 50],
  children: [
    { kind: 'leaf', session: SP_INFO_BASE.id, id: 'p-harness-1' },
    {
      kind: 'split',
      dir: 'col',
      weights: [50, 50],
      children: [
        { kind: 'browser', id: 'b-fixture-1', url: 'http://localhost:5173' },
        { kind: 'editor', id: 'e-fixture-1', path: `${FIXTURE_DIR_ROOT}/README.md` }
      ]
    }
  ]
}
const layoutFixtureProps: Parameters<typeof LayoutView>[0] = {
  tree: LAYOUT_TREE,
  sessions: new Map([[SP_INFO_BASE.id, SP_INFO_BASE]]),
  viewAll: false,
  client: sessionPaneClient,
  theme: 'warm-espresso',
  fontSize: 13,
  copyOnSelect: false,
  stripBoxGlyphs: false,
  activeId: null,
  connected: true,
  expandedId: null,
  registerOutput: () => () => {},
  shellIntegration: true,
  workspaceDir: FIXTURE_DIR_ROOT,
  onReconnectSsh: () => {},
  onActivate: () => {},
  onExpand: () => {},
  onZoom: () => {},
  onShellZoom: () => {},
  onSplit: () => {},
  onMove: () => {},
  onSwap: () => {},
  onResize: () => {},
  onCloseBrowser: () => {},
  onBrowserNavigate: () => {},
  onCloseEditor: () => {},
  onSplitEditor: () => {},
  onHandoff: () => {},
  onOpenFile: () => {},
  onOpenDir: () => {}
}

function AppShell({
  kind
}: {
  kind: 'app' | 'sessions-empty' | 'terminals-empty'
}): React.JSX.Element {
  const appCls = 'h-screen flex flex-col'
  const emptyCls = 'flex-1 flex items-center justify-center text-[var(--text-faint)] gap-[5px]'
  const bCls = 'text-[var(--text-muted)]'
  return (
    <div className={appCls} style={{ background: 'var(--content-bg)' }} data-testid="app-shell">
      <div style={{ height: 44, flex: 'none' }} />
      {kind === 'app' ? (
        <div className="flex-1" />
      ) : kind === 'sessions-empty' ? (
        <div className={emptyCls}>No live sessions yet — launch the swarm first.</div>
      ) : (
        <div className={emptyCls}>
          No terminals here. Press <b className={bCls}>t</b> to open one.
        </div>
      )}
    </div>
  )
}

function OrphanRulesFixture(): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2 p-6">
      <button className={`btn ${BTN_PRIMARY}`}>Primary</button>
    </div>
  )
}

type PrepStep = {
  role?: string
  name?: string
  type?: string
  query?: string
  dragOver?: boolean
  dragEnter?: boolean
  contextMenu?: boolean
  dragTo?: string
  toQuery?: string
  toFrac?: { x: number; y: number }
  hover?: boolean
  activate?: boolean
  call?: string
  ensure?: string
  focusAndReplace?: string
  key?: string
  focus?: boolean
  wait?: number
}

type Surface =
  | 'app'
  | 'app-shell'
  | 'settings'
  | 'shortcut-sheet'
  | 'fixture'
  | 'terminal'
  | 'handoff'
  | 'pane-handoff'
  | 'modal'
  | 'sidebar'
  | 'session-pane'
  | 'layout'

type Assert = {
  sel: string
  prop: string
  is: string
  motion?: 'reduce' | 'no-preference'
  unfrozen?: boolean
}

type Case = {
  id: string
  w: number
  h: number
  surface: Surface
  deliver?: ServerMsg[]
  prep?: PrepStep[]
  assert?: Assert[]
  modal?: ModalKind
  closing?: boolean
  sessionPane?: {
    state?: SessionInfo['state']
    status?: AgentStatus
    expanded?: boolean
    active?: boolean
    showProject?: boolean
    handoff?: boolean
  }
  appShell?: 'app' | 'sessions-empty' | 'terminals-empty'
  /** Screenshot the whole viewport, not the `[data-stage]` element: a
   * `position: fixed` surface's containing block is the viewport, so the stage
   * crop omits it and every state on it compares two empty frames, passing. */
  shootViewport?: boolean
  localStorageSeed?: Record<string, string>
  skipHello?: boolean
}

const focusPane1: PrepStep = { query: '[data-panekey="1"] .term-host', activate: true }

const CASES: Case[] = [
  {
    id: 'app-base',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [focusPane1],
    assert: [
      { sel: '.rpanel', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true },
      { sel: '.side-h-actions button', prop: 'height', is: '24px' },
      { sel: '.side-h-actions button', prop: 'border-radius', is: '4px' }
    ]
  },

  {
    id: 'app-grid-menu',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [{ name: 'Grid layout', ensure: '.grid-menu' }],
    assert: [{ sel: '.grid-menu', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }]
  },

  {
    id: 'app-restore-armed',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [{ name: 'Restore all (2)' }]
  },

  { id: 'app-expanded', w: 1200, h: 800, surface: 'app', prep: [{ name: 'Expand (z)' }] },

  {
    id: 'app-ctx-menu',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [{ role: '*', name: 'Terminal', contextMenu: true }],
    assert: [
      { sel: '.ctx-menu', prop: 'animation-name', is: 'menu-in', motion: 'no-preference', unfrozen: true },
      { sel: '.ctx-menu', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }
    ]
  },

  {
    id: 'app-ctx-menu-closing',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [{ role: '*', name: 'Terminal', contextMenu: true }, { key: 'Escape' }],
    assert: [
      { sel: '.ctx-menu', prop: 'animation-name', is: 'menu-out', motion: 'no-preference', unfrozen: true },
      { sel: '.ctx-menu', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }
    ]
  },

  {
    id: 'app-bell-populated',
    w: 1200,
    h: 800,
    surface: 'app',
    deliver: [{ type: 'agent_notice', session: 3, kind: 'finished' }],
    prep: [{ name: 'Notifications ·' }],
    assert: [{ sel: '.bell-menu', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }]
  },

  {
    id: 'app-bell-closing',
    w: 1200,
    h: 800,
    surface: 'app',
    deliver: [{ type: 'agent_notice', session: 3, kind: 'finished' }],
    prep: [{ name: 'Notifications ·' }, { name: 'Notifications ·' }]
  },

  {
    id: 'app-banners-reconnect',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [{ call: 'error' }, { call: 'disconnect' }]
  },

  {
    id: 'app-boot-connecting',
    w: 900,
    h: 400,
    surface: 'app',
    skipHello: true
  },
  {
    id: 'app-boot-failed',
    w: 900,
    h: 400,
    surface: 'app',
    skipHello: true,
    prep: [{ call: 'disconnect' }]
  },

  { id: 'settings-terminal', w: 900, h: 700, surface: 'settings', prep: [{ name: 'Terminal' }] },

  { id: 'settings-memory', w: 900, h: 700, surface: 'settings', prep: [{ name: 'Memory' }] },

  { id: 'settings-shortcuts', w: 900, h: 700, surface: 'settings', prep: [{ name: 'Shortcuts' }] },

  { id: 'shortcut-sheet', w: 520, h: 640, surface: 'shortcut-sheet', shootViewport: true },

  { id: 'orphan-fixture', w: 400, h: 300, surface: 'fixture' },

  {
    id: 'modal-confirm',
    w: 900,
    h: 700,
    surface: 'modal',
    modal: 'confirm',
    shootViewport: true,
    assert: [
      { sel: '.pop', prop: 'animation-name', is: 'panel-in', motion: 'no-preference', unfrozen: true },
      { sel: '.pop-backdrop', prop: 'animation-name', is: 'backdrop-in', motion: 'no-preference', unfrozen: true },
      { sel: '.pop', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true },
      { sel: '.pop-backdrop', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }
    ]
  },
  {
    id: 'modal-confirm-closing',
    w: 900,
    h: 700,
    surface: 'modal',
    modal: 'confirm',
    closing: true,
    shootViewport: true,
    assert: [
      { sel: '.pop', prop: 'animation-name', is: 'panel-out', motion: 'no-preference', unfrozen: true },
      { sel: '.pop-backdrop', prop: 'animation-name', is: 'backdrop-out', motion: 'no-preference', unfrozen: true },
      { sel: '.pop', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true },
      { sel: '.pop-backdrop', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }
    ]
  },
  { id: 'modal-hostkey', w: 900, h: 700, surface: 'modal', modal: 'hostkey', shootViewport: true },
  { id: 'modal-ssh', w: 900, h: 700, surface: 'modal', modal: 'ssh', shootViewport: true },

  {
    id: 'term-dropzone',
    w: 640,
    h: 420,
    surface: 'terminal',
    prep: [{ query: '.term-host', dragEnter: true }],
    assert: [{ sel: '.term-dropzone', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }]
  },

  {
    id: 'term-toast',
    w: 640,
    h: 420,
    surface: 'terminal',
    prep: [{ call: 'toast' }],
    assert: [{ sel: '.term-toast', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }]
  },

  { id: 'handoff-overlay', w: 900, h: 700, surface: 'handoff' },

  {
    id: 'sidebar-new-menu',
    w: 1200,
    h: 800,
    surface: 'sidebar',
    prep: [
      {
        name: 'Open connection menu',
        ensure: 'button[aria-label="Open connection menu"][aria-expanded="true"]'
      }
    ]
  },

  {
    id: 'sidebar-color-swatches',
    w: 1200,
    h: 800,
    surface: 'sidebar',
    prep: [
      { name: '/home/dev/houston', contextMenu: true },
      { name: 'Change Color', ensure: '[data-testid="swatch"]' }
    ]
  },

  {
    id: 'sidebar-icon-picker',
    w: 1200,
    h: 800,
    surface: 'sidebar',
    prep: [
      { name: '/home/dev/houston', contextMenu: true },
      {
        name: 'Change Icon',
        ensure: '[data-testid="iconpick"][aria-pressed="true"]'
      }
    ]
  },

  {
    id: 'sidebar-drag-workspace',
    w: 1200,
    h: 800,
    surface: 'sidebar',
    prep: [
      {
        name: '/home/dev/houston',
        dragTo: '/home/dev/api-service',
        ensure: '[data-dragging="true"]'
      }
    ]
  },

  {
    id: 'app-editor',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [
      { name: 'Right panel (g opens git)' },
      { name: 'Editor' },
      { name: 'Autosave', ensure: '[role="switch"][aria-checked="false"]' },
      { name: 'Show file tree', ensure: 'button[title="Hide file tree"]' },
      { name: 'src', ensure: '.fchev.rotate-90' },
      { name: 'README.md', ensure: '.fnode[data-active]' },
      { key: 'o' },
      { query: '.rpanel .cm-content', focusAndReplace: 'edited fixture line\n' }
    ]
  },

  {
    id: 'app-editor-status-saved',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [
      { name: 'Right panel (g opens git)' },
      { name: 'Editor' },
      { name: 'Show file tree', ensure: 'button[title="Hide file tree"]' },
      { name: 'src', ensure: '.fchev.rotate-90' },
      { name: 'index.ts', ensure: '.fnode[data-active]' },
      { query: '.rpanel .cm-content', focusAndReplace: 'edited fixture line for estatus\n' },
      { wait: 900 }
    ]
  },

  {
    id: 'app-editor-status-error',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [
      { name: 'Right panel (g opens git)' },
      { name: 'Editor' },
      { name: 'Show file tree', ensure: 'button[title="Hide file tree"]' },
      { name: 'broken.txt' }
    ]
  },

  {
    id: 'app-browser',
    w: 1200,
    h: 800,
    surface: 'app',
    localStorageSeed: {
      'tr-layout:/home/dev/houston': JSON.stringify({
        customized: true,
        cols: 1,
        tree: { kind: 'browser', id: 'b-fixture-1', url: 'http://localhost:5173' }
      })
    },
    prep: [{ query: 'input[aria-label="Address"]', focus: true }]
  },

  { id: 'app-agent-status', w: 1200, h: 800, surface: 'app', prep: [{ name: '/home/dev/status-fixture' }] },

  { id: 'app-empty-grid', w: 1200, h: 800, surface: 'app', prep: [{ name: '/home/dev/empty-workspace' }] },

  {
    id: 'app-shell-base',
    w: 700,
    h: 500,
    surface: 'app-shell',
    appShell: 'app',
    assert: [{ sel: '[data-testid="app-shell"]', prop: 'flex-direction', is: 'column' }]
  },
  {
    id: 'app-shell-sessions-empty',
    w: 700,
    h: 500,
    surface: 'app-shell',
    appShell: 'sessions-empty'
  },
  {
    id: 'app-shell-terminals-empty',
    w: 700,
    h: 500,
    surface: 'app-shell',
    appShell: 'terminals-empty'
  },

  {
    id: 'grid-dz-left',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [
      { name: 'Amber Falcon', toQuery: '[data-panekey="2"]', toFrac: { x: 0.1, y: 0.5 } }
    ]
  },
  {
    id: 'grid-dz-center',
    w: 1200,
    h: 800,
    surface: 'app',
    prep: [
      { name: 'Amber Falcon', toQuery: '[data-panekey="2"]', toFrac: { x: 0.5, y: 0.5 } }
    ]
  },

  { id: 'layout-base', w: 900, h: 600, surface: 'layout' },

  {
    id: 'layout-dz-left',
    w: 900,
    h: 600,
    surface: 'layout',
    prep: [{ name: 'Amber Falcon', toQuery: '[data-panekey="b-fixture-1"]', toFrac: { x: 0.1, y: 0.5 } }]
  },
  {
    id: 'layout-dz-right',
    w: 900,
    h: 600,
    surface: 'layout',
    prep: [{ name: 'Amber Falcon', toQuery: '[data-panekey="b-fixture-1"]', toFrac: { x: 0.9, y: 0.5 } }]
  },
  {
    id: 'layout-dz-top',
    w: 900,
    h: 600,
    surface: 'layout',
    prep: [{ name: 'Amber Falcon', toQuery: '[data-panekey="b-fixture-1"]', toFrac: { x: 0.5, y: 0.1 } }]
  },
  {
    id: 'layout-dz-bottom',
    w: 900,
    h: 600,
    surface: 'layout',
    prep: [{ name: 'Amber Falcon', toQuery: '[data-panekey="b-fixture-1"]', toFrac: { x: 0.5, y: 0.9 } }]
  },
  {
    id: 'layout-dz-center',
    w: 900,
    h: 600,
    surface: 'layout',
    prep: [{ name: 'Amber Falcon', toQuery: '[data-panekey="b-fixture-1"]', toFrac: { x: 0.5, y: 0.5 } }]
  },

  {
    id: 'layout-resizing',
    w: 900,
    h: 600,
    surface: 'layout',
    prep: [
      {
        name: 'Resize left and right panes 1/2',
        toQuery: '[aria-label="Resize left and right panes 1/2"]',
        toFrac: { x: 0.5, y: 0.5 }
      }
    ],
    assert: [{ sel: '.term-host', prop: 'pointer-events', is: 'none' }]
  },

  {
    id: 'sp-base',
    w: 900,
    h: 300,
    surface: 'session-pane',
    sessionPane: { active: true, status: 'working', showProject: true },
    assert: [
      { sel: '.pane', prop: 'opacity', is: '1' },
      { sel: '.agent-dot', prop: 'animation-name', is: 'tr-dot-pulse', motion: 'no-preference', unfrozen: true },
      { sel: '.agent-dot', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true },
      { sel: '[data-testid="pane-sub"], .pane-sub', prop: 'display', is: 'block' },
      { sel: '[data-testid="branch-chip"], .branch-chip', prop: 'display', is: 'flex' },
      { sel: '[data-testid="header-divider"], .header-divider', prop: 'display', is: 'block' }
    ]
  },

  { id: 'pane-handoff', w: 1200, h: 860, surface: 'pane-handoff', shootViewport: true },

  {
    id: 'pane-menu-open',
    w: 900,
    h: 620,
    surface: 'session-pane',
    prep: [{ query: '.pane', contextMenu: true }],
    shootViewport: true
  },

  {
    id: 'sp-handoff-closing',
    w: 900,
    h: 300,
    surface: 'session-pane',
    sessionPane: { handoff: true },
    closing: true
  },

  {
    id: 'sp-expanded',
    w: 900,
    h: 300,
    surface: 'session-pane',
    sessionPane: { expanded: true },
    assert: [{ sel: '.pane', prop: 'flex-grow', is: '1' }]
  },

  {
    id: 'sp-ended-exited',
    w: 900,
    h: 300,
    surface: 'session-pane',
    sessionPane: { state: 'exited' },
    assert: [{ sel: '.pane', prop: 'opacity', is: '0.8' }]
  },

  {
    id: 'sp-ended-killed',
    w: 900,
    h: 300,
    surface: 'session-pane',
    sessionPane: { state: 'killed' },
    assert: [{ sel: '.pane', prop: 'opacity', is: '0.8' }]
  },

  {
    id: 'sp-status-idle',
    w: 900,
    h: 300,
    surface: 'session-pane',
    sessionPane: { status: 'idle' },
    assert: [{ sel: '.agent-dot', prop: 'animation-name', is: 'none', motion: 'no-preference', unfrozen: true }]
  },

  {
    id: 'sp-status-spawning',
    w: 900,
    h: 300,
    surface: 'session-pane',
    sessionPane: { status: 'spawning' },
    assert: [
      { sel: '.agent-dot', prop: 'animation-name', is: 'tr-dot-pulse', motion: 'no-preference', unfrozen: true },
      { sel: '.agent-dot', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }
    ]
  },

  {
    id: 'sp-status-needs-input',
    w: 900,
    h: 300,
    surface: 'session-pane',
    sessionPane: { status: 'needs-input' },
    assert: [
      { sel: '.agent-dot', prop: 'animation-name', is: 'tr-dot-pulse', motion: 'no-preference', unfrozen: true },
      { sel: '.agent-dot', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true }
    ]
  },

  {
    id: 'sp-ctx-menu',
    w: 900,
    h: 400,
    surface: 'session-pane',
    prep: [{ role: '*', name: 'Terminal', contextMenu: true }],
    assert: [
      { sel: '.ctx-sub', prop: 'animation-name', is: 'none', motion: 'reduce', unfrozen: true },
      { sel: '.ctx-sub', prop: 'right', is: 'auto' }
    ]
  },

  {
    id: 'sp-cq-state',
    w: 480,
    h: 300,
    surface: 'session-pane',
    sessionPane: { state: 'exited' },
    assert: [{ sel: '[data-testid="pane-state"], .state', prop: 'display', is: 'none' }]
  },

  {
    id: 'sp-cq-pane-sub',
    w: 390,
    h: 300,
    surface: 'session-pane',
    sessionPane: { showProject: true },
    assert: [{ sel: '[data-testid="pane-sub"], .pane-sub', prop: 'display', is: 'none' }]
  },

]

declare global {
  interface Window {
    __setView: (caseId: string, side: 'old' | 'new', force?: boolean) => Promise<void>
    __cases: { id: string; w: number; h: number; prep: PrepStep[]; assert?: Assert[] }[]
    __harnessCall: (name: string) => void
  }
}

function Surface({
  surface,
  modal,
  closing,
  side,
  sessionPane,
  appShell
}: {
  surface: Surface
  modal?: ModalKind
  closing?: boolean
  side: 'old' | 'new'
  sessionPane?: Case['sessionPane']
  appShell?: Case['appShell']
}): React.JSX.Element {
  switch (surface) {
    case 'modal':
      if (!modal) throw new Error(`Surface: surface 'modal' needs a \`modal\` kind, got ${JSON.stringify(modal)}`)
      return <ModalHost kind={modal} closing={!!closing} />
    case 'app':
      return <App />
    case 'app-shell':
      if (!appShell) throw new Error(`Surface: surface 'app-shell' needs an \`appShell\` kind`)
      return <AppShell kind={appShell} />
    case 'sidebar':
      return <Sidebar {...sidebarFixtureProps} />
    case 'session-pane': {
      const props = sessionPaneFixtureProps(sessionPane ?? {})
      return (
        <div className="pane-slot flex" style={{ height: '100%', width: '100%', position: 'relative' }}>
          {sessionPane?.handoff ? (
            <SessionPaneHandoffHost props={props} closing={!!closing} />
          ) : (
            <SessionPane {...props} />
          )}
        </div>
      )
    }
    case 'layout':
      return (
        <div style={{ height: '100%', width: '100%', display: 'flex', position: 'relative' }}>
          <LayoutView {...layoutFixtureProps} />
        </div>
      )
    case 'settings':
      return <SettingsView {...settingsProps} />
    case 'shortcut-sheet':
      return <ShortcutSheet onClose={() => {}} />
    case 'fixture':
      return <OrphanRulesFixture />
    case 'pane-handoff':
      return (
        <PaneHandoff
          source={{
            session: SP_INFO_BASE.id,
            agent: 'claude',
            title: 'atlas',
            cwd: '/home/tester/Desktop/houston',
            conversation:
              '$ cargo test\nrunning 749 tests\ntest result: ok. 749 passed\n$ git status\nnothing to commit, working tree clean\n'
          }}
          onCancel={() => {}}
          onHandoff={() => {}}
        />
      )
    case 'handoff':
      return (
        <HandoffOverlay
          state={HANDOFF_STATE}
          onCancel={() => {}}
          onClose={() => {}}
          onPaste={() => {}}
        />
      )
    case 'terminal':
      throw new Error('Surface: "terminal" is rendered directly by Stage, not through this switch')
  }
}

function Stage(): React.JSX.Element {
  const [view, setView] = useState<{ caseId: string; side: 'old' | 'new'; nonce: number }>({
    caseId: CASES[0].id,
    side: 'old',
    nonce: 0
  })
  const shownRef = useRef<string | null>(null)

  const terminalClient = useMemo(() => makeTerminalPaneClient(), [])
  const actionsRef = useRef<TermActions | null>(null)
  const sinkRef = useRef<OutputSink | null>(null)
  const registerOutput: RegisterOutput = (_id, sink) => {
    sinkRef.current = sink
    return () => {
      if (sinkRef.current === sink) sinkRef.current = null
    }
  }

  useEffect(() => {
    window.__cases = CASES.map((c) => ({
      id: c.id,
      w: c.w,
      h: c.h,
      prep: c.prep ?? [],
      assert: c.assert,
      shootViewport: c.shootViewport
    }))
    window.__setView = (caseId, side, force) =>
      new Promise((resolve) => {
        if (!force && shownRef.current === `${caseId}:${side}`) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          return
        }
        shownRef.current = `${caseId}:${side}`
        resetSingletons()
        const seed = CASES.find((x) => x.id === caseId)?.localStorageSeed
        if (seed) for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v)
        setView((v) => ({ caseId, side, nonce: v.nonce + 1 }))
        void deliverBoot(caseId, resolve)
      })
    const baseHarnessCall = window.__harnessCall
    window.__harnessCall = (name: string) => {
      if (name === 'toast') {
        if (!actionsRef.current) throw new Error("__harnessCall('toast'): no actions ref mounted yet")
        actionsRef.current.toast('Copied last 40 lines')
        return
      }
      baseHarnessCall(name)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function deliverBoot(caseId: string, resolve: () => void): Promise<void> {
    const c = CASES.find((x) => x.id === caseId)!
    await raf()
    await raf()
    if (c.surface === 'app' && !c.skipHello) {
      deliverToApp(helloOk())
      await raf()
      for (const msg of c.deliver ?? []) deliverToApp(msg)
      await raf()
    }
    await raf()
    resolve()
  }

  const c = CASES.find((x) => x.id === view.caseId)!
  return (
    <div
      data-stage=""
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: c.w,
        height: c.h,
        overflow: 'hidden'
      }}
    >
      <div data-side={view.side} style={{ display: 'contents' }}>
        {c.surface === 'terminal' ? (
          <div
            className="layout relative flex-1 min-h-0 overflow-hidden bg-[var(--rail-bg)]"
            style={{ height: '100%', width: '100%', position: 'relative', display: 'flex' }}
          >
            <section className="pane" style={{ width: '100%', height: '100%' }}>
              <RealTerminalPane
                key={`${view.side}:${c.id}:${view.nonce}`}
                client={terminalClient}
                info={TERMINAL_INFO}
                theme={TERMINAL_THEME}
                active={true}
                connected={true}
                fontSize={TERMINAL_FONT_SIZE}
                copyOnSelect={false}
                stripBoxGlyphs={true}
                registerOutput={registerOutput}
                onActivate={() => {}}
                onZoom={() => {}}
                onShellZoom={() => {}}
                actions={actionsRef}
                onOpenFile={() => {}}
                onOpenDir={() => {}}
              />
            </section>
          </div>
        ) : (
          <Surface
            key={`${view.side}:${c.id}:${view.nonce}`}
            surface={c.surface}
            modal={c.modal}
            closing={c.closing}
            side={view.side}
            sessionPane={c.sessionPane}
            appShell={c.appShell}
          />
        )}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Stage />)
