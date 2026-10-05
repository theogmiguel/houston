import { createSessionsStore, SessionsStoreContext, useLayoutSessions, useSessions } from './sessionsStore';
import { useOrchestrationNotifications } from './orchestrationNotifications';
import type { OrchestrationNotificationContext } from './orchestrationNotifications';
import type { NoticeInput } from './notices';
import { setTaskbarAttentionCount } from './houston/taskbarCount';
import { registerOwned } from './pane/registration';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AgentKind,
  KeymapOverrides,
  HoustonClient,
  ServerMsg,
  SessionInfo,
  SessionPolicy,
  UpdatePolicy,
  UpdateState,
  SshConfigHost,
  SshProfile,
  Workspace,
} from "./houston/client";
import type { AgentHookState } from "./houston/generated/AgentHookState";
import type { TagInfo } from "./houston/generated/TagInfo";
import type { VoiceDevice } from "./houston/generated/VoiceDevice";
import type { VoiceModelState } from "./houston/generated/VoiceModelState";
import type { VoiceSettings } from "./houston/generated/VoiceSettings";
import {
  clearVoiceIndicators,
  insertVoiceText,
  isPersistentVoiceFailure,
  setVoiceIndicator,
  setVoiceLevel,
  setVoicePageError,
  voiceFailureMessage,
  showVoiceNotice,
} from "./voice/store";
import { VoiceMicChip } from "./voice/VoiceMicChip";
import {
  configureDictation,
  dictationFailed,
  dictationTextFor,
  forgetDictationSession,
} from "./voice/dictation";
import type {
  HostInfo,
  McpStateView,
  AgentProfileState,
  OrchestrationStateView,
} from "./components/SettingsView";
import type { PaneRoster } from "./components/DelegationCard";
import type { SkillToolState } from "./houston/generated/SkillToolState";
import type { SkillPushRecord } from "./houston/generated/SkillPushRecord";
import type { ProfileChoice } from "./houston/generated/ProfileChoice";
import {
  isLive,
  LIVE_CHILDREN_MARKER,
  HoustonClient as Client,
} from "./houston/client";
import { USAGE_WINDOW_REFUSED } from "./houston/generated/DEFAULTS";
import type { UsageSummaryMsg } from "./components/UsageSection";
import type { UsageActivityDay } from "./houston/generated/UsageActivityDay";
import { daemonShutdown, daemonStatus } from "./houston/manage";
import { appQuit } from "./houston/tray";
import { useTrayBridge } from "./houston/useTray";
import { stopConfirmCopy } from "./components/daemonStopConfirmCopy";
import { QuitAndStopDaemonConfirm } from "./components/QuitAndStopDaemonConfirm";
import { useBrowserFocus } from "./houston/browserFocus";
import {
  routeBrowserOpenRequest,
  useBrowserOpenRequest,
} from "./houston/browserOpenRequest";
import {
  getLogsDir,
  openExternal,
  pickDirectories,
  pickFile,
  setAllowedRoots,
  showItemInFolder,
  startDragging,
  windowButtonLayout,
  windowControl,
  windowIsMaximized,
} from "./houston/bridge";
import { useShellFocus } from "./Shell/useShellFocus";
import { BrowserActConfirmModal } from "./components/BrowserActConfirm";
import { useBrowserConfirm } from "./houston/browserConfirm";
import { TerminalTuningContext, type OutputSink } from "./pane/TerminalPane";
import { CHROME_THEME_LABELS, THEME_LABELS } from "./theme";
import { revealThemeFromClick } from "./themeReveal";
import {
  FONT_DEFAULT,
  FONT_MIN,
  FONT_MAX,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  usePreferences,
  type DesktopNotificationMode,
} from "./usePreferences";
import { Sidebar } from "./components/Sidebar";
import { useCustomSurface } from "./components/customChrome";
import { MATERIAL_CLS, materialAttrs } from "./components/material";
import { SkillsSurface } from "./components/nav/SkillsSurface";
import { canUseSkillInFocusedPane } from "./houston/skillSurface";
import { McpSurface } from "./components/nav/McpSurface";
import { setSettingsSection, settingsSectionLabel, shouldIgnoreInputKey, useSettingsSection } from "./settingsNav";
import { RoutinesSurface } from "./components/nav/RoutinesSurface";
import { HarnessView, useHarnessActions } from "./components/nav/HarnessView";
import { useHarnessSignals } from "./houston/useHarnessSignals";
import type { Routine, RoutineRefusal, RoutineRun } from "./houston/routineTypes";
import { engineLabel } from "./components/engineLabel";
import { LayoutView } from "./components/LayoutView";
import { AddPanePopover } from "./components/AddPanePopover";
import { Tooltip } from "./components/Tooltip";
import { tabsStorageKey } from "./components/browserTabsKey";
import { recordAndReload } from "./reloadBudget";
import { AnimOut } from "./components/AnimOut";
import {
  BTN_ICO,
  BTN_PRIMARY,
} from "./components/buttonChrome";
import { SurfaceBoundary } from "./components/SurfaceBoundary";
import { Shell } from "./components/Shell/Shell";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { ConfirmModal } from "./components/ConfirmModal";
import type { HandoffSource } from "./components/PaneHandoff";
import type { SessionSlot } from "./components/sessionPresets";
import { LaunchComposerDock, visibleLaunchPreview, type LaunchPreview } from "./components/LaunchComposerDock";
import { WorkspaceEmpty } from "./components/WorkspaceEmpty";
import { useWorkspaceActions } from "./houston/useWorkspaceActions";
import { WorkspacesEmpty } from "./components/WorkspacesEmpty";
import { FirstRun } from "./components/FirstRun";
import { workspaceRefusal } from "./components/workspaceEligibility";
import type {
  SshConnectParams,
  SshInitial,
} from "./components/SshConnectModal";
import {
  enqueueHostKey,
  HostKeyModalHost,
  planRejectRemaining,
  removeHostKeys,
  type HostKeyPrompt,
} from "./components/HostKeyModal";
import {
  closeWorkspaceShortcut,
  commandPaletteShortcut,
  effectiveLabel,
  escapeShortcut,
  browserFocusUrl,
  expandPane,
  tidyGrid,
  equalizePanes,
  focusNextPane,
  focusPrevPane,
  movePaneNext,
  movePanePrev,
  fontZoomIn,
  fontZoomOut,
  fontZoomReset,
  newTerminal as newTerminalShortcut,
  newBrowserPane as newBrowserPaneShortcut,
  openFileShortcut,
  renameWorkspaceShortcut,
  resolveGlobalMatch,
  splitSideFor,
  resolveMatch,
  focusedPaneOwnsKey,
  gridNext,
  gridPrev,
  isModifierKeydown,
  paletteLayer,
  prefixShortcut,
  wsLast,
  wsNext,
  wsPrev,
  selectPane,
  settingsShortcut,
  usageShortcut,
  shortcutSheetShortcut,
  toggleGit,
  togglePanel,
  toggleSidebar,
  zoomIn,
  zoomOut,
  zoomReset,
} from "./keymap";
import { prefixLayer } from "./prefixLayer";
import { PrefixHint } from "./components/PrefixHint";
import {
  paletteNavActions,
  type GridTarget,
  type PaletteActions,
} from "./components/commandRegistry";
import { KeymapOverridesContext } from "./layout/keymapOverridesContext";
import { TagsContext } from "./layout/tagsContext";
import { setRailView, useRailView, type RailView } from "./railView";
import { touchGrid } from "./gridRecency";
import { useNativeSuppressionCount } from "./layout/nativeSuppression";
import type { ReviewDiffsData } from "./git/review";
import { useNotices } from "./notices";
import { NoticeStack } from "./components/NoticeStack";
import {
  IconClose,
  IconGrid,
  IconPanelLeft,
} from "./components/icons";
import { setRailWidth, useRailWidth } from "./railWidth";
import {
  defaultScmWidth,
  focusedRepoDir,
  loadScmOpen,
  saveScmOpen,
  scmWorkspace,
  setScmWidth,
  useScmWidth,
  type ScmTab,
} from "./scmPanel";
import "./components/browserPane.css";
import { SidePanelIntegration } from "./components/SidePanel";
import { focusSideBrowserUrl, useSidePanelState } from "./useSidePanelState";
import { reviewCheckoutDir, SIDE_BROWSER_MOVE_EVENT, openSideBrowser, openSideTasks, loadSideState } from "./sidePanel";
import { terminalSelection } from "./pane/terminalSelection";
import { SourceControlToggle } from "./components/SourceControlToggle";
import { RailResizeHandle } from "./components/RailResizeHandle";
import { useDismissedUpdate } from "./updateDismissal";
import { SettingsBreadcrumb } from "./components/ui/SettingsBreadcrumb";
import { liveSessionCount, UpdateInstallHost } from "./components/UpdateInstallHost";
import { useCheckoutFacts } from "./useCheckoutFacts";
import {
  addGrid,
  autoNameGrid,
  findEditorByPath,
  findPane,
  findStackContaining,
  filesPane,
  gridStorageKey,
  insertBeside,
  insertPaneAt,
  isAutoNameable,
  leaf,
  loadGrids,
  loadLayout,
  migrateSavedGitLeaves,
  moveLeaf,
  preorderLeaves,
  preorderNonSessionPanes,
  preorderSessions,
  tidy,
  equalize,
  adjacentPaneKey,
  regrid,
  removeGrid,
  renameGrid,
  setGridTags,
  dropTagFromGrids,
  gridTagIds,
  reconcileSavedGridTags,
  setActiveStackTab,
  sessionForPaneId,
  removeLeaf,
  saveLayout,
  setRatio,
  stackWith,
  swapLeaf,
  syncWorkspaceGrids,
  respawnedSessions,
  syncSessionLayout,
  unstack,
  updateBrowserUrl,
  type BrowserNode,
  type EditorNode,
  type GridMeta,
  type LayoutNode,
  type LayoutState,
  type PaneKey,
  type SplitSide,
} from "./layout/tree";
import {
  requestReveal,
  dropWorkspaceBuffers,
  dirtyBufferPaths,
  basename,
} from "./editor/bufferStore";
import { applyOrder, partitionPinned, reorderPinned } from "./layout/wsOrder";
import {
  detachPaneToNewWorkspace,
  isWorkspaceEmptyOfSessionsAndSwarms,
  resolveDetachRoot,
  type DetachPayload,
} from "./layout/paneDetach";

export type Conn =
  | { kind: "connecting" }
  | { kind: "ready"; client: HoustonClient }
  | {
      kind: "reconnecting";
      client: HoustonClient;
      error: string | null;
      since: number;
    }
  | { kind: "failed"; error: string };

function readyClient(conn: Conn): HoustonClient | null {
  return conn.kind === "ready" ? conn.client : null;
}

import { isTitlebarDragEligible, isBareTitlebarTarget } from "./titlebar";
import { WindowControls } from "./components/WindowControls";
import {
  parseWindowButtonLayout,
  FALLBACK_WINDOW_BUTTON_LAYOUT,
  type WindowButtonLayout,
} from "./windowButtonLayout";
import { stackCapacity } from "./paneCaps";
import { changedEntries } from "./layout/changedEntries";
import { Icon } from "./components/Icon";

// lazy() keeps Settings (and everything below) out of the boot chunk
// WebKitGTK parses before the grid can paint — `bundle-budget.json`'s
// ratchet enforces this. No launch path opens Settings.
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({
    default: m.SettingsView,
  })),
);
const UsageSection = lazy(() =>
  import("./components/UsageSection").then((m) => ({ default: m.UsageSection })),
);
const CommandPalette = lazy(() =>
  import("./components/ui/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);

const SshConnectModal = lazy(() =>
  import("./components/SshConnectModal").then((m) => ({
    default: m.SshConnectModal,
  })),
);
const PaneHandoff = lazy(() =>
  import("./components/PaneHandoff").then((m) => ({ default: m.PaneHandoff })),
);
const LaunchGridPreview = lazy(() =>
  import("./components/ui/LaunchGridPreview").then((m) => ({ default: m.LaunchGridPreview })),
);
export { isTitlebarDragEligible, isBareTitlebarTarget };

const SELECTED_WS_KEY = "tr-selected-workspace";

// { [workspacePath]: paneId } — the DURABLE pane id, never a session id:
// `respawn` gives the pane a new session id on every restart and boot
// restore, so a stored session id would name nothing by the next boot.
const FOCUSED_PANE_KEY = "tr-focused-pane";

function readFocusedPanes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(FOCUSED_PANE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeFocusedPane(workspace: string, paneId: string): void {
  try {
    localStorage.setItem(
      FOCUSED_PANE_KEY,
      JSON.stringify({ ...readFocusedPanes(), [workspace]: paneId }),
    );
  } catch {
  }
}

const SPLIT_INTENT_TTL_MS = 10_000;
// A Start creates a worktree and launches the agent before its run is bound to
// a pane; 60s covers a slow checkout without letting a refused Start linger.
const TASK_START_INTENT_TTL_MS = 60_000;

const PANE_GROW_TTL_MS = 1_000;

const REVIEW_INTENT_TTL_MS = 10_000;

type SessionStateMessage = Extract<ServerMsg, { type: "session_state" }>;

type RosterPatchMsg = Extract<
  ServerMsg,
  {
    type:
      | "session_renamed"
      | "session_reparented"
      | "live_children_changed"
      | "compactions_changed"
      | "delegation_changed"
      | "session_tags_set"
      | "session_resumable";
  }
>;

const ROSTER_PATCH_TYPES: ReadonlySet<ServerMsg["type"]> = new Set([
  "session_renamed",
  "session_reparented",
  "live_children_changed",
  "compactions_changed",
  "delegation_changed",
  "session_tags_set",
  "session_resumable",
]);

function isRosterPatch(msg: ServerMsg): msg is RosterPatchMsg {
  return ROSTER_PATCH_TYPES.has(msg.type);
}

function patchRosterFields(
  prev: Map<number, SessionInfo>,
  msg: RosterPatchMsg,
): Map<number, SessionInfo> {
  const cur = prev.get(msg.session);
  if (!cur) return prev;
  const patch: Partial<SessionInfo> =
    msg.type === "session_renamed"
      ? { title: msg.title }
      : msg.type === "session_reparented"
        ? { project_dir: msg.project_dir }
        : msg.type === "live_children_changed"
          ? {
              live_children: msg.live_children,
              children_waiting: msg.children_waiting,
            }
          : msg.type === "compactions_changed"
            ? { compactions: msg.compactions }
            : msg.type === "session_tags_set"
              ? { tags: msg.tags }
              : msg.type === "session_resumable"
                ? { resumable: msg.resumable }
                : { delegation: msg.delegation };
  return new Map(prev).set(msg.session, { ...cur, ...patch });
}

function handleTagWireMessage(
  msg: ServerMsg,
  setTags: Dispatch<SetStateAction<TagInfo[]>>,
  reconcileGridTags: (tags: TagInfo[]) => void,
): void {
  if (msg.type === "tag_list") {
    setTags(msg.tags);
    reconcileGridTags(msg.tags);
  } else if (msg.type === "tag_deleted") {
    setTags((prev) => prev.filter((t) => t.id !== msg.tag));
  }
}

// A roster patch is applied here and settles the message; the dispatch below
// continues only for the messages that are not one.
function patchRosterIfNeeded(
  msg: ServerMsg,
  setSessions: Dispatch<SetStateAction<Map<number, SessionInfo>>>,
): boolean {
  if (!isRosterPatch(msg)) return false;
  setSessions((prev) => patchRosterFields(prev, msg));
  return true;
}

// After a hello, restore the selected workspace: the remembered one when it
// still exists, else the first; an empty roster opens the launcher instead.
function applyWorkspaceSelection(
  workspaces: Workspace[],
  setShowLauncher: Dispatch<SetStateAction<boolean>>,
  setSelectedWs: Dispatch<SetStateAction<string>>,
): void {
  if (workspaces.length === 0) {
    setShowLauncher(true);
    return;
  }
  setSelectedWs((cur) => {
    if (workspaces.some((w) => w.path === cur)) return cur;
    const remembered = localStorage.getItem(SELECTED_WS_KEY);
    if (remembered && workspaces.some((w) => w.path === remembered)) {
      return remembered;
    }
    return workspaces[0].path;
  });
}

// The rail indicator offers exactly one thing: a release that is newer than this
// build and that nobody has waved off yet. The daemon keeps offering the same
// release until a newer one exists, so "Later" is renderer state, not wire state.
function offeredUpdate(
  update: { state: UpdateState } | null,
  dismissed: string | null,
): string | null {
  if (update?.state.kind !== "available") return null;
  const version = update.state.release.version;
  return version === dismissed ? null : version;
}

const RECONNECT_MS = 1000;
const ReconnectBanner = lazy(() => import('./components/ReconnectBanner').then((module) => ({ default: module.ReconnectBanner })))
const TasksSurface = lazy(() => import('./components/nav/TasksSurface').then((module) => ({ default: module.TasksSurface })))

// Connections before its first `mcp_state` shows empty lists, not a missing view.
function mcpSurfaceLists(mcp: McpStateView | null) {
  return {
    source: mcp?.source ?? [],
    tools: mcp?.tools ?? [],
    results: mcp?.results ?? [],
    checks: mcp?.checks ?? [],
    loaded: mcp !== null,
    sourcePath: mcp?.sourcePath ?? null,
  };
}

function focusedSurfaceOwnsKey(surface: "grid" | "side", event: KeyboardEvent, activeId: number | null, layerArmed: boolean): boolean {
  if (activeId === null || layerArmed) return false;
  if (surface === "side") return event.key === "Escape" || ((event.ctrlKey || event.metaKey) && ["s", "l"].includes(event.key.toLowerCase()));
  return focusedPaneOwnsKey(event);
}

const ZOOM_STEPS: readonly (readonly [typeof zoomIn, "zoom" | "font", -1 | 0 | 1])[] = [
  [zoomIn, "zoom", 1],
  [zoomOut, "zoom", -1],
  [zoomReset, "zoom", 0],
  [fontZoomIn, "font", 1],
  [fontZoomOut, "font", -1],
  [fontZoomReset, "font", 0],
];

function matchZoomStep(e: KeyboardEvent, overrides: KeymapOverrides): { target: "zoom" | "font"; step: -1 | 0 | 1 } | null {
  for (const [entry, target, step] of ZOOM_STEPS) {
    if (resolveGlobalMatch(entry, overrides)(e)) return { target, step };
  }
  return null;
}

function harnessAttentionFor(overview: readonly { workspace: string; attention: number }[], workspace: string): number {
  if (workspace === "all") return overview.reduce((total, row) => total + row.attention, 0);
  return overview.find((row) => row.workspace === workspace)?.attention ?? 0;
}

function sessionLabel(sessions: ReadonlyMap<number, { title?: string | null }>, id: number | null): string | undefined {
  if (id === null) return undefined;
  return sessions.get(id)?.title ?? `Session ${id}`;
}

function SessionEffects({
  connection,
  workspaces,
  onFocusPane,
  rosterRevision,
  desktopNotificationMode,
  inAppNotifications,
  visiblePaneIds,
  getNotificationContext,
  pushNotificationNotice,
  onDesktopDelivery
}: {
  connection: Parameters<typeof useTrayBridge>[0]["connection"];
  workspaces: Workspace[];
  onFocusPane: (id: number) => void;
  rosterRevision: number;
  desktopNotificationMode: DesktopNotificationMode;
  inAppNotifications: boolean;
  visiblePaneIds: ReadonlySet<number>;
  getNotificationContext: (session: SessionInfo) => OrchestrationNotificationContext;
  pushNotificationNotice: (notice: NoticeInput) => void;
  onDesktopDelivery: (allowed: boolean, error?: string) => void;
}): null {
  const sessions = useSessions();
  useOrchestrationNotifications({
    sessions,
    rosterRevision,
    desktopMode: desktopNotificationMode,
    inAppEnabled: inAppNotifications,
    visiblePaneIds,
    getContext: getNotificationContext,
    onFocusPane,
    pushNotice: pushNotificationNotice,
    onDesktopDelivery
  });
  useTrayBridge({ connection, sessions, workspaces, onFocusPane });
  return null;
}

export function App(): React.JSX.Element {
  const [conn, setConn] = useState<Conn>({ kind: "connecting" });
  const dismissedUpdate = useDismissedUpdate();
  const customChrome = useCustomSurface();

  // A brief blur can be incidental; sustained blur pauses ambient animation.
  useEffect(() => {
    let mounted = true;
    let dispose: (() => void) | undefined;
    void import("./motionPause").then(({ watchMotionPause }) => {
      if (mounted) dispose = watchMotionPause();
    });
    return () => { mounted = false; dispose?.(); };
  }, []);

  const [buttonLayout, setButtonLayout] = useState<WindowButtonLayout>(
    FALLBACK_WINDOW_BUTTON_LAYOUT,
  );
  useEffect(() => {
    let alive = true;
    void windowButtonLayout().then((raw) => {
      if (alive) setButtonLayout(parseWindowButtonLayout(raw));
    });
    return () => {
      alive = false;
    };
  }, []);

  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      void windowIsMaximized().then((v) => {
        if (alive) setMaximized(v);
      });
    };
    const onResize = (): void => {
      clearTimeout(timer);
      timer = setTimeout(read, 80);
    };
    read();
    window.addEventListener("resize", onResize);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  const [sessionsStore] = useState(createSessionsStore);
  const sessions = useLayoutSessions(sessionsStore);
  const setSessions = sessionsStore.set;
  const [rosterRevision, setRosterRevision] = useState(0);
  const [openedAttention, setOpenedAttention] = useState<ReadonlySet<number>>(() => new Set());
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const appNotices = useNotices();
  const orchestrationNotices = useNotices();
  const [desktopNotificationDelivery, setDesktopNotificationDelivery] = useState<{ allowed: boolean; error?: string } | null>(null);
  const [selectedWs, setSelectedWs] = useState("all");
  const harnessOverview = useHarnessSignals(conn.kind === "ready" ? conn.client : null);
  const harnessAttention = harnessAttentionFor(harnessOverview, selectedWs);
  const [taskTurnCount, setTaskTurnCount] = useState(0);
  const {
    activeId,
    setActiveId,
    activeLeaf,
    setActiveLeaf,
    expandedId,
    setExpandedId,
    sidebarRail,
    setSidebarRail,
    settings,
    setSettings,
    handleExpand,
    expandedIn,
  } = useShellFocus();
  const railWidth = useRailWidth();
  const editorLeafSeq = useRef(0);
  const browserLeafSeq = useRef(0);
  const currentTreeRef = useRef<LayoutNode | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const reconnectRef = useRef<() => void>(() => {});
  const [sshConfigHosts, setSshConfigHosts] = useState<SshConfigHost[]>([]);
  const [sshKeyringError, setSshKeyringError] = useState<string | null>(null);
  const [sessionPolicy, setSessionPolicy] = useState<SessionPolicy | null>(
    null,
  );
  const [update, setUpdate] = useState<{
    policy: UpdatePolicy;
    state: UpdateState;
  } | null>(null);
  const [agentHooks, setAgentHooks] = useState<AgentHookState[] | null>(null);
  const [agentHooksCheckedAt, setAgentHooksCheckedAt] = useState<number | null>(null);
  const [skillsCheckedAt, setSkillsCheckedAt] = useState<number | null>(null);
  const [mcpCheckedAt, setMcpCheckedAt] = useState<number | null>(null);
  const [orchestration, setOrchestration] =
    useState<OrchestrationStateView | null>(null);
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [usage, setUsage] = useState<UsageSummaryMsg | null>(null);
  const [usageActivity, setUsageActivity] = useState<UsageActivityDay[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [historyIgnoreGlobs, setHistoryIgnoreGlobs] = useState<string[] | null>(
    null,
  );
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings | null>(
    null,
  );
  const [voiceCloudKeyPresent, setVoiceCloudKeyPresent] = useState(false);
  const [voiceKeyringError, setVoiceKeyringError] = useState<string | null>(
    null,
  );
  const [voiceModels, setVoiceModels] = useState<VoiceModelState[]>([]);
  const [voiceDevices, setVoiceDevices] = useState<VoiceDevice[]>([]);
  const [mcp, setMcp] = useState<McpStateView | null>(null);
  const [skills, setSkills] = useState<SkillToolState[] | null>(null);
  const [skillPushes, setSkillPushes] = useState<SkillPushRecord[]>([]);
  const [skillAutoPush, setSkillAutoPush] = useState(false);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileState | null>(
    null,
  );
  const [keymapOverrides, setKeymapOverrides] = useState<KeymapOverrides>({
    bindings: {},
    shortcuts_enabled: true,
  });
  const [historyCount, setHistoryCount] = useState<number | null>(null);

  useEffect(() => {
    if (settings && conn.kind === "ready") {
      conn.client.agentProfileList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    setHistoryCount(null);
    if (settings && conn.kind === "ready") {
      conn.client.historyCount();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesRunning, setRoutinesRunning] = useState<number[]>([]);
  const [routineRefusal, setRoutineRefusal] = useState<RoutineRefusal | null>(
    null,
  );
  const lastRoutineRequest = useRef<{
    attemptedName?: string;
    routineName?: string;
  } | null>(null);
  const [routineRuns, setRoutineRuns] = useState<Record<number, RoutineRun[]>>({});
  const [routineRunsLoading, setRoutineRunsLoading] = useState<number | null>(null);
  const lastRoutineRunsRequest = useRef<number | null>(null);

  const settingsSection = useSettingsSection();
  const railView = useRailView();
  useEffect(() => {
    if (conn.kind !== "ready") {
      setTaskTurnCount(0);
      return;
    }
    const scope = selectedWs === "all" ? "all" : selectedWs;
    let current = true;
    const off = conn.client.subscribe("task_snapshot", (msg) => {
      if (msg.scope !== scope) return;
      void import("./components/tasks/format").then(({ queueGroupOf }) => {
        if (current) setTaskTurnCount(msg.tasks.filter((task) => queueGroupOf(task) === "your-turn").length);
      });
    });
    conn.client.taskSnapshot(scope);
    return () => {
      current = false;
      off();
    };
  }, [conn, selectedWs]);
  useEffect(() => {
    if (settings) setRailView(null);
  }, [settings]);

  useEffect(() => {
    if (settings && settingsSection === "agents" && conn.kind === "ready") {
      conn.client.agentHooks();
    }
  }, [settings, settingsSection, conn]);

  // Keyed on railView opening only: these read ~/.claude.json under the
  // read-only carve-out in docs/internals/invariants.md — surface open,
  // explicit refresh, or boot only, never a timer.
  useEffect(() => {
    if (conn.kind !== "ready") return;
    if (railView === "mcp") conn.client.mcpState();
    if (railView === "skills") conn.client.skillSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railView]);
  const [composer, setComposer] = useState<"current-grid" | "new-grid" | null>(
    null,
  );
  const [launchPreview, setLaunchPreview] = useState<LaunchPreview | null>(null);
  const [showLauncher, setShowLauncher] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [workspaceRefusals, setWorkspaceRefusals] = useState<string[]>([]);
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(
    null,
  );
  const workspacesEmptyOpen =
    showLauncher || (conn.kind === "ready" && workspaces.length === 0);

  const [firstRunOpen, setFirstRunOpen] = useState(false);
  useEffect(() => {
    if (conn.kind === "ready" && workspaces.length === 0) setFirstRunOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.kind, workspaces.length]);
  const closeFirstRun = useCallback(() => setFirstRunOpen(false), []);
  const firstRunOrchestrationConsented =
    orchestration !== null && orchestration.enabled;
  const firstRunHooksInstalled =
    agentHooks !== null && agentHooks.some((h) => h.installed);
  // A COUNT, not a boolean: the grid is hidden rather than unmounted, and
  // with a boolean, whichever overlay closes first would un-hide a grid
  // another one is still covering. Add an overlay here, not an OR expression.
  const openOverlays = [
    settings,
    railView !== null,
    composer,
    firstRunOpen || workspacesEmptyOpen,
  ].filter(Boolean).length;
  useNativeSuppressionCount("grid-hidden", openOverlays);
  const gridHidden = openOverlays > 0;
  const [shortcutSheet, setShortcutSheet] = useState(false);
  const [confirmRemoveWs, setConfirmRemoveWs] = useState<{
    path: string;
    message: string;
    confirmLabel: string;
  } | null>(null);
  const [quitAndStopDaemonConfirm, setQuitAndStopDaemonConfirm] = useState<{
    message: string;
  } | null>(null);
  const [liveChildrenConfirm, setLiveChildrenConfirm] = useState<{
    session: number;
    kind: "kill" | "close";
    message: string;
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const {
    theme,
    themeChoice,
    setTheme,
    chromeTheme,
    setChromeTheme,
    chromeMigrationNotice,
    chromeMigrationNoticeDismissed,
    setChromeMigrationNoticeDismissed,
    fontSize,
    setFontSize,
    terminalLineHeight,
    setTerminalLineHeight,
    terminalCursorBlink,
    setTerminalCursorBlink,
    terminalScrollbackLines,
    setTerminalScrollbackLines,
    uiZoom,
    setUiZoom,
    shiftEnterNewline,
    setShiftEnterNewline,
    openLinksInPane,
    setOpenLinksInPane,
    fontFamilyId,
    setFontFamilyId,
    fontFamily,
    wsColors,
    setWsColors,
    wsOrder,
    setWsOrder,
    wsPinned,
    setWsPinned,
    shellIntegration,
    setShellIntegration,
    osc52,
    setOsc52,
    osc52Ref,
    copyOnSelect,
    setCopyOnSelect,
    stripBoxGlyphs,
    setStripBoxGlyphs,
    desktopNotificationMode,
    setDesktopNotificationMode,
    inAppNotifications,
    setInAppNotifications,
    changeFont,
    changeZoom,
  } = usePreferences();
  const terminalTuning = useMemo(
    () => ({
      lineHeight: terminalLineHeight,
      cursorBlink: terminalCursorBlink,
      scrollbackLines: terminalScrollbackLines,
    }),
    [terminalLineHeight, terminalCursorBlink, terminalScrollbackLines],
  );
  // Migrate saved trees before any layout read, so a legacy Changes leaf can
  // never cost a browser/editor/terminal leaf; a workspace that had the pane
  // comes back with the panel already open.
  const [scmOpen, setScmOpen] = useState<boolean>(() =>
    migrateSavedGitLeaves().length > 0 ? true : loadScmOpen(),
  );
  const [scmTab, setScmTab] = useState<ScmTab>("changes");
  const scmWidth = useScmWidth();
  const { sideRequest, setSideRequest, activeSurface, setActiveSurface, sideWorkspace, pickerTarget, sideReview, setSideReview, sideExpanded, setSideExpanded } = useSidePanelState(selectedWs, activeId, sessions, scmOpen, setScmOpen, (workspace) => revealWorkspace(workspace));
  const gridSurfaceHidden = gridHidden || sideExpanded;
  const [wsRenaming, setWsRenaming] = useState<string | null>(null);
  // Keyed by `gridStorageKey(path, gridId)` for a real workspace, never the
  // bare path — 'all' is the one exception, bypassing grids entirely.
  const [layouts, setLayouts] = useState<Map<string, LayoutState>>(new Map());
  const [gridsByWs, setGridsByWs] = useState<Map<string, GridMeta[]>>(
    new Map(),
  );
  const [selectedGridByWs, setSelectedGridByWs] = useState<Map<string, string>>(
    new Map(),
  );
  const gridsFor = useCallback(
    (path: string): GridMeta[] => gridsByWs.get(path) ?? loadGrids(path),
    [gridsByWs],
  );
  const activeGridId = useCallback(
    (path: string): string => {
      const grids = gridsFor(path);
      const sel = selectedGridByWs.get(path);
      return sel && grids.some((g) => g.id === sel) ? sel : grids[0].id;
    },
    [gridsFor, selectedGridByWs],
  );
  const gridsByWsRef = useRef(gridsByWs);
  gridsByWsRef.current = gridsByWs;
  const dropDeletedTagFromGrids = useCallback((tag: number): void => {
    for (const path of gridsByWsRef.current.keys()) {
      const next = dropTagFromGrids(path, tag);
      if (next) setGridsByWs((prev) => new Map(prev).set(path, next));
    }
  }, []);
  const reconcileGridTags = useCallback((tags: TagInfo[]): void => {
    const updated = reconcileSavedGridTags(new Set(tags.map((tag) => tag.id)));
    if (updated.size === 0) return;
    setGridsByWs((prev) => {
      const next = new Map(prev);
      for (const [path, grids] of updated) {
        if (prev.has(path)) next.set(path, grids);
      }
      return next;
    });
  }, []);
  const selectedGridByWsRef = useRef(selectedGridByWs);
  selectedGridByWsRef.current = selectedGridByWs;
  const keyForRef = (path: string): string => {
    if (path === "all") return "all";
    const grids = gridsByWsRef.current.get(path) ?? loadGrids(path);
    const sel = selectedGridByWsRef.current.get(path);
    const gridId = sel && grids.some((g) => g.id === sel) ? sel : grids[0].id;
    return gridStorageKey(path, gridId);
  };
  useEffect(() => {
    setGridsByWs((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const w of workspaces) {
        if (!next.has(w.path)) {
          next.set(w.path, loadGrids(w.path));
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [workspaces]);
  const outputHandlers = useRef<Map<number, OutputSink>>(new Map());
  const splitIntents = useRef<
    {
      anchor: number;
      side: SplitSide;
      ws: string;
      projectDir: string;
      agent: AgentKind;
      ts: number;
    }[]
  >([]);
  // Starts this client sent, so the pane the daemon creates for one is placed
  // beside the pane that was focused; a run started by another client or an
  // agent has no entry and keeps the default placement.
  const taskStartIntents = useRef<
    { taskId: number; anchor: number | null; ws: string; ts: number }[]
  >([]);
  const newPaneOrigins = useRef<Map<PaneKey, SplitSide>>(new Map());
  const reviewIntents = useRef<
    { projectDir: string; data: ReviewDiffsData; ts: number }[]
  >([]);

  const pendingAct = useBrowserConfirm();
  const wsPinnedSet = useMemo(() => new Set(wsPinned), [wsPinned]);
  const orderedWorkspaces = useMemo(() => {
    const { pinned, unpinned } = partitionPinned(
      applyOrder(workspaces, wsOrder),
      wsPinnedSet,
    );
    return [...pinned, ...unpinned];
  }, [workspaces, wsOrder, wsPinnedSet]);
  const wsColorIndex = useMemo(() => {
    const m: Record<string, number> = {};
    workspaces.forEach((w, i) => {
      m[w.path] = i;
    });
    return m;
  }, [workspaces]);
  const selectedWsRef = useRef(selectedWs);
  selectedWsRef.current = selectedWs;
  // "Last workspace" for the prefix layer: the one selected before the current one.
  const lastWsRef = useRef<string | null>(null);
  const prevSelectedWsRef = useRef(selectedWs);
  useEffect(() => {
    if (prevSelectedWsRef.current !== selectedWs) {
      lastWsRef.current = prevSelectedWsRef.current;
      prevSelectedWsRef.current = selectedWs;
    }
  }, [selectedWs]);
  const selectWorkspaceFromKeyboard = useCallback((path: string): void => {
    setSelectedWs(path);
    setShowLauncher(false);
  }, []);
  const stepWorkspace = useCallback(
    (offset: 1 | -1): void => {
      const list = orderedWorkspaces;
      if (list.length === 0) return;
      const idx = list.findIndex((w) => w.path === selectedWs);
      const next =
        idx === -1
          ? offset > 0
            ? 0
            : list.length - 1
          : (idx + offset + list.length) % list.length;
      selectWorkspaceFromKeyboard(list[next].path);
    },
    [orderedWorkspaces, selectedWs, selectWorkspaceFromKeyboard],
  );
  const lastWorkspace = useCallback((): string | null => {
    const last = lastWsRef.current;
    if (last === null) return null;
    return last === "all" || workspaces.some((w) => w.path === last)
      ? last
      : null;
  }, [workspaces]);
  const selectLastWorkspace = useCallback((): void => {
    const last = lastWorkspace();
    if (last !== null) selectWorkspaceFromKeyboard(last);
  }, [lastWorkspace, selectWorkspaceFromKeyboard]);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const sessionsRef = useMemo(() => ({ get current() { return sessionsStore.getSnapshot(); } }), [sessionsStore]);
  const taskbarAttentionCount = useMemo(() => [...sessions.values()].filter((session) =>
    session.state === 'running' && session.status === 'needs-input' &&
    session.spawned_by == null && !session.hidden && !openedAttention.has(session.id)
  ).length, [sessions, openedAttention]);
  useEffect(() => {
    void setTaskbarAttentionCount(taskbarAttentionCount).catch(() => {});
  }, [taskbarAttentionCount]);
  useEffect(() => {
    setOpenedAttention((current) => {
      const next = new Set(current);
      for (const id of current) {
        const session = sessions.get(id);
        if (!session || session.status !== 'needs-input') next.delete(id);
      }
      return next.size === current.size ? current : next;
    });
  }, [sessions]);
  useEffect(() => {
    if (activeId === null || sessions.get(activeId)?.status !== 'needs-input') return;
    setOpenedAttention((current) => new Set(current).add(activeId));
  }, [activeId, sessions]);
  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;
  const savedLayoutsRef = useRef(layouts);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const voiceSettingsRef = useRef(voiceSettings);
  voiceSettingsRef.current = voiceSettings;
  const dictationTargetRef = useRef<number | null>(null);

  const paneRoster = useMemo<PaneRoster>(() => ({
    sessions,
    maxLiveChildren: orchestration?.caps.max_live_children ?? null,
  }), [sessions, orchestration]);

  const focusPane = (session: number): void => {
    const target = sessionsRef.current.get(session);
    if (!target) return;
    if (target.status === 'needs-input') {
      setOpenedAttention((current) => new Set(current).add(session));
    }
    for (const w of workspacesRef.current) {
      for (const g of gridsFor(w.path)) {
        const key = gridStorageKey(w.path, g.id);
        const tree = layouts.get(key)?.tree ?? loadLayout(key).tree;
        if (preorderSessions(tree).includes(session)) {
          setSelectedWs(w.path);
          handleSelectGrid(w.path, g.id);
          setActiveId(session);
          return;
        }
      }
    }
    setSelectedWs(target.project_dir);
    setActiveId(session);
  };

  const [focusBrowserUrl, setFocusBrowserUrl] = useState(0);
  const [reviewSessions, setReviewSessions] = useState<
    Map<string, { session: number; data: ReviewDiffsData }>
  >(new Map());

  const [paneHandoff, setPaneHandoff] = useState<HandoffSource | null>(null);

  // The checkout facts lifecycle (state, requests, propagation, notes) lives in
  // its own module; App only wires it into the message dispatch and the panes.
  const checkout = useCheckoutFacts({
    conn,
    activeId,
    sessions,
    sessionsRef,
    workspaces,
  });

  const [sshModal, setSshModal] = useState(false);
  const [sshPrefill, setSshPrefill] = useState<SshInitial | null>(null);
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([]);
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPrompt[]>([]);
  const hostKeyPrompt = hostKeyQueue[0] ?? null;
  const sshRequestSeq = useRef(0);

  const pushNotice = appNotices.push;
  const pushError = useCallback(
    (text: string) => {
      pushNotice({ code: `error:${text}`, kind: "error", title: text });
    },
    [pushNotice],
  );

  const workspaceActionState = useWorkspaceActions({
    client: readyClient(conn),
    workspace: selectedWs,
    shellIntegration,
    keymapOverrides,
    setExpandedId,
    onError: pushError,
  });
  const { actions: workspaceActions } = workspaceActionState;
  const workspaceActionsFor = (path: string) => workspaceActionState.byWorkspace[path] ?? [];
  const onBackgroundUnavailable = useCallback(
    (reason: string) => {
      pushError(`The window background could not be loaded (${reason}).`);
    },
    [pushError],
  );

  useEffect(() => {
    let cancelled = false;
    let bootTimer: ReturnType<typeof setTimeout> | undefined;

    function handleSessionState(msg: SessionStateMessage): void {
      setSessions((prev) => {
        const next = new Map(prev);
        const s = next.get(msg.session);
        if (s) next.set(msg.session, { ...s, state: msg.state, status_since_ms: Date.now() });
        return next;
      });
      if (!isLive(msg.state)) {
        setActiveId((cur) => (cur === msg.session ? null : cur));
      }
    }

    function wire(client: HoustonClient, boot: boolean): void {
      let helloed = false;
      let helloError: string | null = null;
      client.subscribeAll((msg: ServerMsg) => {
        if (cancelled) return;
        if (!helloed) {
          if (msg.type === "hello_ok") {
            helloed = true;
            if (boot) clearTimeout(bootTimer);
            setConn({ kind: "ready", client });
          } else if (msg.type === "error") {
            helloError = msg.message;
            return;
          }
        }
        if (patchRosterIfNeeded(msg, setSessions)) return;
        handleTagWireMessage(msg, setTags, reconcileGridTags);
        if (msg.type === "tag_deleted") dropDeletedTagFromGrids(msg.tag);
        checkout.handleMessage(msg);
        switch (msg.type) {
          case "hello_ok":
            client.snapshotAttach = msg.snapshot_attach;
            client.snapshotFormatVersion = msg.snapshot_format_version;
            reconcileGridTags(msg.tags);
            setSessions(new Map(msg.sessions.map((s) => [s.id, s])));
            setRosterRevision((revision) => revision + 1);
            setWorkspaces(msg.workspaces);
            setTags(msg.tags);
            // Facts and pending asks belong to the connection that made them:
            // a replaced connection re-asks rather than trusting a lost reply.
            checkout.reset(msg.sessions);
            checkout.requestForRoster(client, msg.sessions);
            applyWorkspaceSelection(msg.workspaces, setShowLauncher, setSelectedWs);
            client.sessionPolicyGet();
            client.agentHooks();
            client.routineList();
            client.orchestrationSettingsGet();
            client.voiceSettingsGet();
            client.keymapGet();
            break;
          case "session_list":
            setSessions(new Map(msg.sessions.map((s) => [s.id, s])));
            setRosterRevision((revision) => revision + 1);
            break;
          case "session_created": {
            setSessions((prev) => new Map(prev).set(msg.info.id, msg.info));
            if (msg.info.spawned_by == null) setActiveId(msg.info.id);
            checkout.requestForSession(client, msg.info);
            {
              const rv = reviewIntents.current;
              while (
                rv.length > 0 &&
                Date.now() - rv[0].ts > REVIEW_INTENT_TTL_MS
              )
                rv.shift();
              const hit = rv.findIndex(
                (i) => i.projectDir === msg.info.project_dir,
              );
              if (hit !== -1) {
                const [claimed] = rv.splice(hit, 1);
                const reviewer = msg.info.id;
                setReviewSessions((prev) =>
                  new Map(prev).set(claimed.projectDir, {
                    session: reviewer,
                    data: claimed.data,
                  }),
                );
              }
            }
            const q = splitIntents.current;
            while (q.length > 0 && Date.now() - q[0].ts > SPLIT_INTENT_TTL_MS)
              q.shift();
            const head = q[0];
            if (
              head &&
              head.projectDir === msg.info.project_dir &&
              head.agent === msg.info.agent
            ) {
              q.shift();
              const newId = msg.info.id;
              const headKey = keyForRef(head.ws);
              newPaneOrigins.current.set(newId, head.side);
              setTimeout(
                () => newPaneOrigins.current.delete(newId),
                PANE_GROW_TTL_MS,
              );
              setLayouts((prev) => {
                const cur = prev.get(headKey) ?? loadLayout(headKey);
                if (
                  !cur.tree ||
                  !preorderLeaves(cur.tree).includes(head.anchor)
                )
                  return prev;
                const tree = insertBeside(
                  cur.tree,
                  head.anchor,
                  leaf(newId),
                  head.side,
                );
                return new Map(prev).set(headKey, { ...cur, tree });
              });
            }
            break;
          }
          case "session_state":
            handleSessionState(msg);
            break;
          case "session_removed":
            setSessions((prev) => {
              const next = new Map(prev);
              next.delete(msg.session);
              return next;
            });
            setExpandedId((cur) => (cur === msg.session ? null : cur));
            setActiveId((cur) => (cur === msg.session ? null : cur));
            forgetDictationSession(msg.session);
            setVoiceIndicator(msg.session, null);
            break;
          case "workspace_list":
            setWorkspaces(msg.workspaces);
            if (msg.workspaces.length > 0)
              setSelectedWs((cur) =>
                msg.workspaces.some((w) => w.path === cur)
                  ? cur
                  : msg.workspaces[0].path,
              );
            break;
          case "agent_detected":
            setSessions((prev) => {
              const next = new Map(prev);
              const s = next.get(msg.session);
              if (s) next.set(msg.session, { ...s, detected_agent: msg.agent });
              return next;
            });
            break;
          case "agent_status":
            setSessions((prev) => {
              const s = prev.get(msg.session);
              if (!s || s.status === msg.status) return prev;
              return new Map(prev).set(msg.session, { ...s, status: msg.status, status_since_ms: Date.now() });
            });
            break;
          case "session_context":
            setSessions((prev) => {
              const next = new Map(prev);
              const s = next.get(msg.session);
              if (s) next.set(msg.session, { ...s, context: msg.context ?? null });
              return next;
            });
            break;

          case "clipboard_set":
            if (osc52Ref.current) {
              void navigator.clipboard.writeText(msg.text).then(
                () =>
                  outputHandlers.current.get(msg.session)?.clipboardCopied(),
                () => {},
              );
            }
            break;
          case "ssh_profiles":
            setSshProfiles(msg.profiles);
            setSshKeyringError(msg.keyring_error ?? null);
            break;
          case "ssh_host_key":
            setHostKeyQueue((q) => enqueueHostKey(q, msg));
            break;
          case "ssh_config_hosts":
            setSshConfigHosts(msg.hosts);
            break;
          case "skill_sync":
            setSkills(msg.tools);
            setSkillPushes(msg.pushes);
            setSkillAutoPush(msg.auto_push_enabled);
            setSkillsCheckedAt(Date.now());
            break;
          case "mcp_state":
            setMcp({
              source: msg.source,
              sourcePath: msg.source_path,
              tools: msg.tools,
              results: msg.results,
              checks: msg.checks,
            });
            setMcpCheckedAt(Date.now());
            break;
          case "agent_profile_state":
            setAgentProfiles({ profiles: msg.profiles, active: msg.active });
            break;
          case "routines":
            setRoutines(msg.routines);
            setRoutinesRunning(msg.running);
            setRoutineRefusal(null);
            break;
          case "routine_runs": {
            const id = lastRoutineRunsRequest.current;
            lastRoutineRunsRequest.current = null;
            setRoutineRunsLoading(null);
            if (id !== null) setRoutineRuns((prev) => ({ ...prev, [id]: msg.runs }));
            break;
          }
          case "routine_run_event":
            setRoutineRuns((prev) => {
              const current = prev[msg.run.routine_id];
              if (current === undefined) return prev;
              const next = current.filter((r) => r.id !== msg.run.id);
              next.unshift(msg.run);
              next.sort((a, b) => b.id - a.id);
              return { ...prev, [msg.run.routine_id]: next };
            });
            break;
          case "routine_refused":
            setRoutineRefusal({
              id: msg.id ?? null,
              kind: msg.kind,
              limit: msg.limit ?? null,
              requested: msg.requested ?? null,
              ...(lastRoutineRequest.current ?? {}),
            });
            break;
          case "agent_hooks":
            setAgentHooks(msg.providers);
            setAgentHooksCheckedAt(Date.now());
            break;
          case "host_info":
            setHostInfo(msg);
            break;
          case "usage_summary":
            setUsage(msg);
            setUsageLoading(false);
            setUsageError(null);
            break;
          case "usage_activity_summary":
            setUsageActivity(msg.days);
            break;
          case "command_history_ignore_globs":
            setHistoryIgnoreGlobs(msg.globs);
            break;
          case "voice_settings":
            setVoiceSettings(msg.settings);
            setVoiceCloudKeyPresent(msg.cloud_key_present);
            setVoiceKeyringError(msg.keyring_error ?? null);
            setVoiceModels(msg.models);
            if (!msg.settings.enabled) clearVoiceIndicators();
            break;
          case "voice_devices":
            setVoiceDevices(msg.devices);
            break;
          case "voice_level":
            setVoiceLevel(msg.rms);
            break;
          case "voice_model_state":
            setVoiceModels((prev) => {
              const next = prev.map((m) =>
                m.id === msg.model.id ? msg.model : m,
              );
              return next.some((m) => m.id === msg.model.id)
                ? next
                : [...next, msg.model];
            });
            break;
          case "voice_state": {
            const st = msg.state;
            if (st.state === "listening") {
              setVoicePageError(null);
              setVoiceIndicator(st.session, { kind: "listening" });
            } else if (st.state === "transcribing") {
              setVoiceIndicator(st.session, { kind: "transcribing" });
            } else if (st.state === "idle") {
              clearVoiceIndicators();
            } else {
              const message = voiceFailureMessage(st.failure);
              const target = dictationTargetRef.current;
              if (isPersistentVoiceFailure(st.failure)) {
                setVoicePageError(message);
                pushError(message);
                if (target !== null) dictationFailed(target);
              } else if (target === null || !showVoiceNotice(target, message)) {
                pushError(message);
              }
            }
            break;
          }
          case "voice_transcript": {
            const policy = {
              outputMode: voiceSettingsRef.current?.output_mode ?? "original",
              agentPreamble: voiceSettingsRef.current?.agent_preamble ?? false,
            };
            const text = dictationTextFor(msg.session, msg.text, policy);
            if (text === "") {
              if (
                !showVoiceNotice(
                  msg.session,
                  "The transcript was empty — nothing was inserted.",
                )
              ) {
                pushError("The transcript was empty — nothing was inserted.");
              }
              break;
            }
            if (voiceSettingsRef.current?.insert_mode === "confirm_first") {
              setVoiceIndicator(msg.session, { kind: "pending", text });
              break;
            }
            if (!insertVoiceText(msg.session, text)) {
              pushError(
                `Pane ${msg.session} is gone — the dictated text was dropped, not sent somewhere else.`,
              );
              break;
            }
            setVoiceIndicator(msg.session, null);
            break;
          }
          case "session_policy":
            setSessionPolicy(msg.policy);
            break;
          case "orchestration_state":
            setOrchestration({
              caps: msg.caps,
              enabled: msg.enabled,
              acpAgents: msg.acp_agents,
            });
            break;
          case "keymap":
            setKeymapOverrides(msg.overrides);
            break;
          case "history_count":
            setHistoryCount(msg.count);
            break;
          case "error": {
            if (msg.message.startsWith(USAGE_WINDOW_REFUSED)) {
              setUsageLoading(false);
              setUsageError(
                msg.message.slice(USAGE_WINDOW_REFUSED.length).trim(),
              );
              break;
            }
            if (msg.message.startsWith(LIVE_CHILDREN_MARKER)) {
              const intent = client.takeRecentDestroyIntent();
              if (intent) {
                setLiveChildrenConfirm({
                  session: intent.session,
                  kind: intent.kind,
                  message: msg.message,
                });
                break;
              }
            }
            pushError(msg.message);
            break;
          }
        }
      });
      client.onFrame = (session, offset, payload) =>
        outputHandlers.current.get(session)?.frame(offset, payload);
      client.onReplay = (session, data, bytesSeen) =>
        outputHandlers.current.get(session)?.replay(data, bytesSeen);
      client.onSnapshot = (session, state, outputOffset) =>
        outputHandlers.current.get(session)?.snapshot(state, outputOffset);
      client.onGap = (session) => outputHandlers.current.get(session)?.gap();
      client.onResizeExhausted = (session) =>
        outputHandlers.current.get(session)?.resizeExhausted();
      client.onClose = () => {
        if (cancelled) return;
        if (boot && !helloed) {
          clearTimeout(bootTimer);
          setConn({
            kind: "failed",
            error: helloError ?? "daemon connection closed",
          });
          return;
        }
        setConn((prev) => {
          if (prev.kind === "ready")
            return {
              kind: "reconnecting",
              client: prev.client,
              error: helloError,
              since: Date.now(),
            };
          if (prev.kind === "reconnecting")
            return { ...prev, error: helloError };
          return prev;
        });
        retryTimerRef.current = setTimeout(reconnect, RECONNECT_MS);
      };
    }

    function reconnect(): void {
      Client.connect()
        .then((client) => {
          if (!cancelled) wire(client, false);
        })
        .catch(() => {
          if (!cancelled)
            retryTimerRef.current = setTimeout(reconnect, RECONNECT_MS);
        });
    }
    reconnectRef.current = reconnect;

    bootTimer = setTimeout(() => {
      if (!cancelled)
        setConn((prev) =>
          prev.kind === "connecting"
            ? { kind: "failed", error: "daemon did not respond within 12s" }
            : prev,
        );
    }, 12_000);

    let bootClient: HoustonClient | null = null;
    Client.connect()
      .then((client) => {
        if (cancelled) {
          client.close();
          return;
        }
        bootClient = client;
        wire(client, true);
      })
      .catch((e: Error) => {
        clearTimeout(bootTimer);
        if (!cancelled) setConn({ kind: "failed", error: e.message });
      });
    return () => {
      cancelled = true;
      clearTimeout(retryTimerRef.current);
      clearTimeout(bootTimer);
      bootClient?.close();
    };
  }, [pushError, retryNonce, reconcileGridTags, dropDeletedTagFromGrids]);

  const registerOutput = useCallback((id: number, sink: OutputSink) => {
    return registerOwned(outputHandlers.current, id, sink);
  }, []);

  const addWorkspaceFromPicker = useCallback(async (): Promise<void> => {
    if (conn.kind !== "ready") return;
    setPickingWorkspace(true);
    setWorkspaceRefusals([]);
    setAddWorkspaceError(null);
    try {
      const picked = await pickDirectories();
      if (picked === null || picked.length === 0) return;
      const refusals: string[] = [];
      const accepted: string[] = [];
      for (const path of picked) {
        const refusal = workspaceRefusal(path);
        if (refusal !== null) refusals.push(refusal);
        else if (!accepted.includes(path)) accepted.push(path);
      }
      setWorkspaceRefusals(refusals);
      for (const path of accepted) conn.client.addWorkspace(path);
      if (accepted.length > 0) {
        setSelectedWs(accepted[accepted.length - 1]);
        setShowLauncher(false);
        setComposer("current-grid");
      }
    } catch (err: unknown) {
      setAddWorkspaceError(
        `This workspace could not be added: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPickingWorkspace(false);
    }
  }, [conn]);

  const replacedSessions = useMemo(
    () => respawnedSessions(sessions.values()),
    [sessions],
  );

  const warmLayouts = useMemo(() => {
    const map = new Map<string, LayoutState>();
    for (const w of orderedWorkspaces) {
      const grids = gridsFor(w.path);
      const active = activeGridId(w.path);
      const wsSessionIds = [...sessions.values()]
        .filter((sess) => sess.project_dir === w.path || sessions.get(sess.spawned_by ?? -1)?.project_dir === w.path)
        .map((sess) => sess.id)
        .sort((a, b) => a - b);
      const synced = syncWorkspaceGrids(
        w.path,
        grids,
        active,
        wsSessionIds,
        layouts,
        replacedSessions,
        wsSessionIds.filter((id) => sessions.get(id)?.spawned_by == null),
      );
      for (const [key, st] of synced) map.set(key, st);
    }
    return map;
  }, [
    orderedWorkspaces,
    layouts,
    sessions,
    replacedSessions,
    gridsFor,
    activeGridId,
  ]);

  const gridsByWorkspace = useMemo(() => {
    const out: Record<
      string,
      {
        id: string;
        name: string;
        count?: number;
        sessionIds?: number[];
        tagIds?: number[];
        paneTagIds?: number[];
      }[]
    > = {};
    for (const w of orderedWorkspaces) {
      out[w.path] = gridsFor(w.path).map((g) => {
        const st = warmLayouts.get(gridStorageKey(w.path, g.id));
        const tagIds = gridTagIds(g);
        if (!st) return { id: g.id, name: g.name, tagIds };
        const ids = preorderSessions(st.tree);
        const paneTagIds = [
          ...new Set(
            ids.flatMap((id) => sessions.get(id)?.tags ?? []),
          ),
        ];
        return {
          id: g.id,
          name: g.name,
          count: ids.length,
          sessionIds: ids,
          tagIds,
          paneTagIds,
        };
      });
    }
    return out;
  }, [orderedWorkspaces, gridsFor, warmLayouts, sessions]);

  const paletteGrids: GridTarget[] = useMemo(
    () =>
      orderedWorkspaces.flatMap((w) =>
        (gridsByWorkspace[w.path] ?? []).map((g) => ({
          path: w.path,
          workspaceName: w.name,
          gridId: g.id,
          name: g.name,
        })),
      ),
    [orderedWorkspaces, gridsByWorkspace],
  );

  const wsIds = [...sessions.values()]
    .filter((s) => selectedWs === "all" || s.project_dir === selectedWs || sessions.get(s.spawned_by ?? -1)?.project_dir === selectedWs)
    .map((s) => s.id)
    .sort((a, b) => a - b);
  const idsKey = wsIds.join(",");

  useEffect(() => {
    const roots = new Set(workspaces.map((w) => w.path));
    for (const s of sessions.values()) roots.add(s.project_dir);
    void setAllowedRoots([...roots]).catch((err: unknown) => {
      console.warn("houston: setAllowedRoots failed", err);
    });
  }, [workspaces, sessions]);

  useEffect(() => {
    if (selectedWs !== "all" || conn.kind !== "ready") return;
    const ids = idsKey ? idsKey.split(",").map(Number) : [];
    setLayouts((prev) => {
      const cur = prev.get("all") ?? loadLayout("all");
      const tree = syncSessionLayout(cur.tree, ids, cur.cols, replacedSessions, ids.filter((id) => sessions.get(id)?.spawned_by == null));
      return new Map(prev).set("all", { ...cur, tree });
    });
  }, [selectedWs, idsKey, replacedSessions, conn.kind]);

  const gridSyncKey = useMemo(() => {
    const perWs = workspaces
      .map((w) => {
        const ids = [...sessions.values()]
          .filter((s) => s.project_dir === w.path || sessions.get(s.spawned_by ?? -1)?.project_dir === w.path)
          .sort((a, b) => a.id - b.id)
          .map((s) => `${s.id}:${s.spawned_by ?? "root"}`)
          .join(",");
        const grids = gridsFor(w.path)
          .map((g) => g.id)
          .join(",");
        return `${w.path}#${ids}#${grids}#${activeGridId(w.path)}`;
      })
      .sort()
      .join("|");
    return `${perWs}~sel:${selectedWs}`;
  }, [workspaces, sessions, gridsFor, activeGridId, selectedWs]);
  const lastGridSync = useRef("");

  useEffect(() => {
    if (lastGridSync.current === gridSyncKey) return;
    lastGridSync.current = gridSyncKey;
    setLayouts((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const w of workspaces) {
        const grids = gridsFor(w.path);
        const active = activeGridId(w.path);
        const wsSessionIds = [...sessions.values()]
          .filter((s) => s.project_dir === w.path || sessions.get(s.spawned_by ?? -1)?.project_dir === w.path)
          .map((s) => s.id)
          .sort((a, b) => a - b);
        const synced = syncWorkspaceGrids(
          w.path,
          grids,
          active,
          wsSessionIds,
          prev,
          replacedSessions,
          wsSessionIds.filter((id) => sessions.get(id)?.spawned_by == null),
        );
        for (const [key, st] of synced) {
          next.set(key, st);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [
    gridSyncKey,
    workspaces,
    sessions,
    replacedSessions,
    gridsFor,
    activeGridId,
  ]);

  useEffect(() => {
    if (conn.kind !== "ready") return;
    conn.client.hostInfoGet();
    const timer = setInterval(() => conn.client.hostInfoGet(), 30_000);
    return () => clearInterval(timer);
  }, [conn]);

  const handleTaskStartRequested = useCallback((taskId: number, ws: string): void => {
    const focused = activeIdRef.current;
    taskStartIntents.current.push({
      taskId,
      anchor: focused,
      ws,
      ts: Date.now(),
    });
  }, []);

  useEffect(() => {
    if (conn.kind !== "ready") return;
    const offRun = conn.client.subscribe("task_run_changed", (msg) => {
      const session = msg.run.session_id;
      if (session == null) return;
      const q = taskStartIntents.current;
      while (q.length > 0 && Date.now() - q[0].ts > TASK_START_INTENT_TTL_MS)
        q.shift();
      const at = q.findIndex((i) => i.taskId === msg.run.task_id);
      if (at === -1) return;
      const [intent] = q.splice(at, 1);
      const key = gridStorageKey(intent.ws, activeGridId(intent.ws));
      setLayouts((prev) => {
        const cur = prev.get(key) ?? loadLayout(key);
        const anchor = intent.anchor;
        if (!cur.tree || anchor === null || anchor === session) return prev;
        const placed = preorderSessions(cur.tree);
        if (!placed.includes(anchor)) return prev;
        const tree = placed.includes(session)
          ? moveLeaf(cur.tree, session, anchor, "right")
          : insertBeside(cur.tree, anchor, leaf(session), "right");
        return new Map(prev).set(key, { ...cur, tree });
      });
      setActiveId(session);
    });
    const offRefused = conn.client.subscribe("task_refused", (msg) => {
      taskStartIntents.current = taskStartIntents.current.filter(
        (i) => i.taskId !== msg.id,
      );
    });
    return () => {
      offRun();
      offRefused();
    };
  }, [conn, activeGridId]);

  // Subscribed rather than another arm in the dispatcher above: that function is
  // the file's largest and the complexity ratchet only falls.
  useEffect(() => {
    if (conn.kind !== "ready") return;
    const stop = conn.client.subscribe("update", (msg) =>
      setUpdate({ policy: msg.policy, state: msg.state }),
    );
    conn.client.updateGet();
    return stop;
  }, [conn]);

  // Settings → Usage's only ingress, deliberately not on a timer: a scan
  // reads transcript files Houston does not own, and a repeat window would
  // re-read gigabytes for a number that moves on human timescales.
  const requestUsage = useCallback(
    (sinceMs: number, untilMs: number, refreshPricing: boolean, workspace: string | null = null) => {
      if (conn.kind !== "ready") return;
      setUsageLoading(true);
      setUsageError(null);
      conn.client.usageSummaryGet(sinceMs, untilMs, refreshPricing, workspace);
    },
    [conn],
  );

  const requestUsageActivity = useCallback((sinceMs: number, untilMs: number, workspace: string | null) => {
    if (conn.kind !== "ready") return;
    conn.client.usageActivitySummaryGet(sinceMs, untilMs, workspace);
  }, [conn]);

  useEffect(() => {
    if (selectedWs !== "all") localStorage.setItem(SELECTED_WS_KEY, selectedWs);
  }, [selectedWs]);

  useEffect(() => {
    saveScmOpen(scmOpen);
  }, [scmOpen]);

  useEffect(() => {
    for (const [key, st] of changedEntries(savedLayoutsRef.current, layouts)) saveLayout(key, st);
    savedLayoutsRef.current = layouts;
  }, [layouts]);

  const mutateTree = useCallback((fn: (t: LayoutNode) => LayoutNode | null) => {
    const key = keyForRef(selectedWsRef.current);
    setLayouts((prev) => {
      const cur = prev.get(key) ?? loadLayout(key);
      if (!cur.tree) return prev;
      const tree = fn(cur.tree);
      return new Map(prev).set(key, { ...cur, tree });
    });
  }, []);

  const mutateTreeAt = useCallback(
    (path: string, fn: (t: LayoutNode) => LayoutNode | null) => {
      const key = keyForRef(path);
      setLayouts((prev) => {
        const cur = prev.get(key) ?? loadLayout(key);
        if (!cur.tree) return prev;
        const tree = fn(cur.tree);
        return new Map(prev).set(key, { ...cur, tree });
      });
    },
    [],
  );

  const wsState: LayoutState = useMemo(() => {
    if (selectedWs === "all") {
      const cur = layouts.get("all");
      if (cur) return cur;
      const persisted = loadLayout("all");
      return {
        ...persisted,
        tree: syncSessionLayout(persisted.tree, wsIds, persisted.cols, replacedSessions, wsIds.filter((id) => sessions.get(id)?.spawned_by == null)),
      };
    }
    const key = gridStorageKey(selectedWs, activeGridId(selectedWs));
    return warmLayouts.get(key) ?? loadLayout(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts, warmLayouts, selectedWs, idsKey, activeGridId, replacedSessions]);
  const currentTree = wsState.tree;
  currentTreeRef.current = currentTree;
  const mountedGridSessionIds = new Set<number>();
  for (const state of warmLayouts.values()) {
    for (const id of preorderSessions(state.tree)) mountedGridSessionIds.add(id);
  }
  for (const id of preorderSessions(currentTree)) mountedGridSessionIds.add(id);
  const moveChildToGrid = (parent: number, child: number): void => {
    const path = sessions.get(parent)?.project_dir;
    if (!path) return;
    const key = gridStorageKey(path, activeGridId(path));
    setLayouts((prev) => {
      const cur = prev.get(key) ?? warmLayouts.get(key) ?? loadLayout(key);
      const tree = cur.tree ? insertBeside(cur.tree, parent, leaf(child), "right") : leaf(child);
      return new Map(prev).set(key, { ...cur, tree });
    });
    setSelectedWs(path);
    setActiveId(child);
  };
  const returnChildToRoster = (child: number): void => {
    setLayouts((prev) => {
      const next = new Map(prev);
      const allLayouts = new Map([...warmLayouts, ...prev]);
      for (const [key, state] of allLayouts) {
        if (preorderSessions(state.tree).includes(child) && state.tree) {
          next.set(key, { ...state, tree: removeLeaf(state.tree, child) });
        }
      }
      return next;
    });
    const parent = sessions.get(child)?.spawned_by;
    if (parent != null) setActiveId(parent);
  };
  const orderedIds = preorderSessions(currentTree);

  useEffect(() => {
    if (selectedWs === "all" || activeId === null || !currentTree) return;
    const pane = findPane(currentTree, activeId);
    if (pane) writeFocusedPane(selectedWs, pane.id);
  }, [selectedWs, activeId, currentTree]);

  const autoFocusedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (selectedWs === "all" || !currentTree) return;
    if (autoFocusedRef.current.has(selectedWs)) return;
    const rememberedPane = readFocusedPanes()[selectedWs];
    if (rememberedPane === undefined) return;
    const live = preorderSessions(currentTree).filter((id) =>
      isLive(sessions.get(id)?.state ?? "exited"),
    );
    if (live.length === 0) return;
    autoFocusedRef.current.add(selectedWs);
    const remembered = sessionForPaneId(currentTree, rememberedPane);
    setActiveId(
      remembered !== null && live.includes(remembered) ? remembered : live[0],
    );
  }, [selectedWs, sessions, currentTree, setActiveId]);

  const resetLayout = (n: number): void => {
    const key = keyForRef(selectedWs);
    setLayouts((prev) => {
      const cur = prev.get(key) ?? loadLayout(key);
      return new Map(prev).set(key, {
        tree: regrid(cur.tree, preorderSessions(cur.tree), n),
        cols: n,
      });
    });
  };

  const handleSelectGrid = useCallback((path: string, gridId: string): void => {
    setSelectedGridByWs((prev) => new Map(prev).set(path, gridId));
    setSelectedWs(path);
    setShowLauncher(false);
    touchGrid(path, gridId);
  }, []);
  const stepGrid = useCallback(
    (offset: 1 | -1): void => {
      if (selectedWs === "all") return;
      const grids = gridsFor(selectedWs);
      if (grids.length < 2) return;
      const idx = grids.findIndex((g) => g.id === activeGridId(selectedWs));
      const next = (Math.max(idx, 0) + offset + grids.length) % grids.length;
      handleSelectGrid(selectedWs, grids[next].id);
    },
    [selectedWs, gridsFor, activeGridId, handleSelectGrid],
  );
  const handleAddGrid = useCallback((path: string): void => {
    const next = addGrid(path, "Untitled");
    setGridsByWs((prev) => new Map(prev).set(path, next));
    setSelectedGridByWs((prev) =>
      new Map(prev).set(path, next[next.length - 1].id),
    );
  }, []);
  const launchSessions = useCallback(
    (slots: SessionSlot[], target: "this-grid" | "new-grid"): void => {
      if (conn.kind !== "ready" || selectedWs === "all") return;
      setExpandedId(null);
      if (target === "new-grid") handleAddGrid(selectedWs);
      for (const slot of slots) {
        conn.client.createSession({
          agent: slot.agent,
          project_dir: selectedWs,
          shell_integration: shellIntegration,
          model: slot.model,
          effort: slot.effort,
          prompt:
            slot.agent === "shell" || slot.prompt === "" ? null : slot.prompt,
        });
      }
      setComposer(null);
      setLaunchPreview(null);
    },
    [conn, selectedWs, shellIntegration, handleAddGrid],
  );
  const handleLaunchPreview = useCallback(
    (slots: SessionSlot[], target: "this-grid" | "new-grid"): void => {
      setLaunchPreview({ slots, target });
    },
    [],
  );

  const handleRenameGrid = useCallback(
    (path: string, gridId: string, name: string): void => {
      setGridsByWs((prev) =>
        new Map(prev).set(path, renameGrid(path, gridId, name)),
      );
    },
    [],
  );
  useEffect(() => {
    for (const [path, grids] of gridsByWs) {
      for (const g of grids) {
        if (!isAutoNameable(g)) continue;
        const st = layouts.get(gridStorageKey(path, g.id));
        if (!st) continue;
        const ids = preorderSessions(st.tree);
        if (ids.length === 0) continue;
        const first = sessions.get(ids[0]);
        if (!first) continue;
        const name =
          first.agent === "shell" ? "Terminal" : engineLabel(first.agent);
        const renamed = autoNameGrid(path, g.id, name);
        setGridsByWs((prev) => new Map(prev).set(path, renamed));
      }
    }
  }, [gridsByWs, layouts, sessions]);
  // A legacy grid's tags were its panes' union, written to every pane: move the
  // union to the grid once and clear the panes. An empty tree may be unsynced.
  useEffect(() => {
    if (conn.kind !== "ready") return;
    for (const [path, grids] of gridsByWs) {
      for (const g of grids) {
        if (g.tags !== undefined) continue;
        const st = layouts.get(gridStorageKey(path, g.id));
        if (!st) continue;
        const known = preorderSessions(st.tree)
          .map((id) => sessions.get(id))
          .filter((s): s is SessionInfo => s !== undefined);
        if (known.length === 0) continue;
        const tagged = known.filter((s) => (s.tags ?? []).length > 0);
        const union = [...new Set(tagged.flatMap((s) => s.tags))];
        const next = setGridTags(path, g.id, union);
        setGridsByWs((prev) => new Map(prev).set(path, next));
        for (const s of tagged) conn.client.setSessionTags(s.id, []);
      }
    }
  }, [conn, gridsByWs, layouts, sessions]);
  const handleRemoveGrid = useCallback((path: string, gridId: string): void => {
    const before = gridsByWsRef.current.get(path) ?? loadGrids(path);
    const next = removeGrid(path, gridId);
    if (next.length === before.length) return;
    setGridsByWs((prev) => new Map(prev).set(path, next));
    setLayouts((prev) => {
      const key = gridStorageKey(path, gridId);
      if (!prev.has(key)) return prev;
      const nm = new Map(prev);
      nm.delete(key);
      return nm;
    });
    setSelectedGridByWs((prev) => {
      if (prev.get(path) !== gridId) return prev;
      return new Map(prev).set(path, next[0].id);
    });
  }, []);

  const handleStackWith = useCallback(
    (dragged: PaneKey, target: PaneKey): void => {
      const key = keyForRef(selectedWsRef.current);
      const cur = layoutsRef.current.get(key) ?? loadLayout(key);
      if (cur.tree) {
        const container = findStackContaining(cur.tree, target);
        const cap = stackCapacity();
        if (container && container.children.length >= cap) {
          pushError(
            `Stack is full (${container.children.length}/${cap}) — can't add a ${
              container.children.length + 1
            }th tab. Raise "Panes per stack" in Settings → Orchestration, or open a new cell`,
          );
          return;
        }
      }
      mutateTree((t) => stackWith(t, dragged, target));
    },
    [mutateTree, pushError],
  );
  const handleSelectStackTab = useCallback(
    (path: string, stackId: string, key: PaneKey): void => {
      mutateTreeAt(path, (t) => setActiveStackTab(t, stackId, key));
    },
    [mutateTreeAt],
  );
  const handleUnstack = useCallback(
    (path: string, key: PaneKey): void => {
      mutateTreeAt(path, (t) => unstack(t, key));
    },
    [mutateTreeAt],
  );

  const handleSplit = useCallback(
    (session: number, side: SplitSide): void => {
      const info = sessions.get(session);
      if (!info || conn.kind !== "ready") return;
      splitIntents.current.push({
        anchor: session,
        side,
        ws: selectedWs,
        projectDir: info.project_dir,
        agent: "shell",
        ts: Date.now(),
      });
      conn.client.createSession({
        agent: "shell",
        project_dir: info.project_dir,
        cwd_from: session,
        shell_integration: shellIntegration,
      });
    },
    [sessions, conn, selectedWs, shellIntegration],
  );
  const handleSplitFromLayout = useCallback(
    (session: number, side: SplitSide): void => {
      if (session === expandedId) setExpandedId(null);
      handleSplit(session, side);
    },
    [expandedId, handleSplit],
  );
  const handleMove = useCallback(
    (dragged: PaneKey, target: PaneKey, side: SplitSide): void => {
      if (typeof dragged === "number" && !sessions.has(dragged)) return;
      if (typeof target === "number" && !sessions.has(target)) return;
      mutateTree((t) => moveLeaf(t, dragged, target, side));
    },
    [sessions, mutateTree],
  );
  const handleSwap = useCallback(
    (a: PaneKey, b: PaneKey): void => {
      if (typeof a === "number" && !sessions.has(a)) return;
      if (typeof b === "number" && !sessions.has(b)) return;
      mutateTree((t) => swapLeaf(t, a, b));
    },
    [sessions, mutateTree],
  );

  const tidyPanes = useCallback((): void => {
    setExpandedId(null);
    mutateTree((t) => tidy(t));
  }, [mutateTree, setExpandedId]);
  const equalizePanesNow = useCallback((): void => {
    mutateTree((t) => equalize(t));
  }, [mutateTree]);
  const paneCount = preorderLeaves(currentTree).length;

  const focusPaneKey = useCallback(
    (key: PaneKey): void => {
      const tree = currentTreeRef.current;
      if (tree) {
        const container = findStackContaining(tree, key);
        if (container)
          mutateTree((t) => setActiveStackTab(t, container.id, key));
      }
      if (typeof key === "number") {
        setActiveLeaf(null);
        setActiveId(key);
      } else {
        setActiveId(null);
        setActiveLeaf(key);
      }
    },
    [mutateTree, setActiveId, setActiveLeaf],
  );
  const keyboardTargetPane = useCallback(
    (): PaneKey | null =>
      activeLeaf ??
      activeId ??
      preorderLeaves(currentTreeRef.current)[0] ??
      null,
    [activeLeaf, activeId],
  );
  const focusAdjacentPane = useCallback(
    (offset: number): void => {
      const from = keyboardTargetPane();
      if (from === null) return;
      const next = adjacentPaneKey(currentTreeRef.current, from, offset);
      if (next !== null) focusPaneKey(next);
    },
    [keyboardTargetPane, focusPaneKey],
  );
  const movePaneFrom = useCallback(
    (from: PaneKey, offset: number): void => {
      const target = adjacentPaneKey(currentTreeRef.current, from, offset);
      if (target === null) return;
      mutateTree((t) => swapLeaf(t, from, target));
      focusPaneKey(from);
    },
    [mutateTree, focusPaneKey],
  );
  const movePaneBy = useCallback(
    (offset: number): void => {
      const from = keyboardTargetPane();
      if (from === null) return;
      movePaneFrom(from, offset);
    },
    [keyboardTargetPane, movePaneFrom],
  );
  const swapPaneAdjacent = useCallback(
    (session: number, offset: 1 | -1): void => movePaneFrom(session, offset),
    [movePaneFrom],
  );

  const orderedIdsForSkillRef = useRef(orderedIds);
  orderedIdsForSkillRef.current = orderedIds;
  const connForSkillRef = useRef(conn);
  connForSkillRef.current = conn;
  const runSkill = useCallback(
    (invoke: string): void => {
      const cur = connForSkillRef.current;
      if (cur.kind !== "ready") return;
      const target =
        (activeIdRef.current !== null && isLive(sessionsRef.current.get(activeIdRef.current)?.state ?? "exited")
          ? activeIdRef.current : null) ??
        orderedIdsForSkillRef.current.find((id) =>
          isLive(sessionsRef.current.get(id)?.state ?? "exited"),
        ) ??
        null;
      if (target === null) {
        pushError("no live terminal in this workspace to receive the skill");
        return;
      }
      setActiveId(target);
      if (!cur.client.sendStdin(target, invoke)) {
        pushError("connection lost — skill invocation was not delivered");
      }
    },
    [pushError],
  );
  const canRunSkill = conn.kind === "ready" && orderedIds.some(
    (id) => isLive(sessions.get(id)?.state ?? "exited"),
  );
  const skillDistribution = {
    tools: skills,
    pushes: skillPushes,
    onPush: (tool: AgentKind, skill: string) => {
      if (conn.kind === "ready") conn.client.skillPush(tool, skill);
    },
    onPushUndo: (tool: AgentKind, skill: string) => {
      if (conn.kind === "ready") conn.client.skillPushUndo(tool, skill);
    },
  };
  const handleResize = useCallback(
    (path: number[], index: number, ratio: number): void =>
      mutateTree((t) => setRatio(t, path, index, ratio)),
    [mutateTree],
  );

  const closeBrowser = useCallback(
    (id: string): void => {
      mutateTree((t) => removeLeaf(t, id));
      localStorage.removeItem(tabsStorageKey(id));
    },
    [mutateTree],
  );
  const browserNavigate = useCallback(
    (id: string, url: string): void => {
      mutateTree((t) => updateBrowserUrl(t, id, url));
    },
    [mutateTree],
  );
  const openBrowserPane = useCallback(
    (workspaceDir: string, anchor: PaneKey | null, url = ""): void => {
      setExpandedId(null);
      if (anchor === null) {
        openSideBrowser(`b${Date.now()}-${++browserLeafSeq.current}`, url, workspaceDir);
        return;
      }
      const key = keyForRef(workspaceDir);
      setLayouts((prev) => {
        const cur = prev.get(key) ?? loadLayout(key);
        const node: BrowserNode = {
          kind: "browser",
          id: `b${Date.now()}-${++browserLeafSeq.current}`,
          url,
        };
        return new Map(prev).set(key, {
          ...cur,
          tree: insertPaneAt(cur.tree, node, anchor),
        });
      });
    },
    [],
  );
  useEffect(() => {
    const move = (event: Event): void => {
      const { id, url, workspace } = (event as CustomEvent<{ id: string; url: string; workspace: string }>).detail;
      const key = keyForRef(workspace);
      setLayouts((prev) => {
        const cur = prev.get(key) ?? loadLayout(key);
        return new Map(prev).set(key, { ...cur, tree: insertPaneAt(cur.tree, { kind: "browser", id, url }, null) });
      });
      setActiveSurface("grid");
      setActiveLeaf(id);
    };
    window.addEventListener(SIDE_BROWSER_MOVE_EVENT, move);
    return () => window.removeEventListener(SIDE_BROWSER_MOVE_EVENT, move);
  }, [setActiveLeaf]);
  const sendPickerToAgent = useCallback((text: string): void => {
    const target = pickerTarget.current;
    const cur = connForSkillRef.current;
    if (target === null || cur.kind !== "ready" || !isLive(sessionsRef.current.get(target)?.state ?? "exited")) return;
    if (!cur.client.sendStdin(target, text)) pushError("connection lost — selected element was not delivered");
  }, [pushError]);
  const pickerAvailable = pickerTarget.current !== null && isLive(sessions.get(pickerTarget.current)?.state ?? "exited");
  const pickerTargetLabel = sessionLabel(sessions, pickerTarget.current);

  const openFilesPaneAt = useCallback(
    (workspaceDir: string, root: string, anchor: PaneKey | null): void => {
      setExpandedId(null);
      const key = keyForRef(workspaceDir);
      const node = filesPane(root);
      setLayouts((prev) => {
        const cur = prev.get(key) ?? loadLayout(key);
        return new Map(prev).set(key, {
          ...cur,
          tree: insertPaneAt(cur.tree, node, anchor),
        });
      });
      setActiveLeaf(node.id);
    },
    [setActiveLeaf],
  );
  const closeFiles = useCallback(
    (id: string): void => {
      mutateTree((t) => removeLeaf(t, id));
    },
    [mutateTree],
  );

  const closeEditor = useCallback(
    (id: string): void => {
      mutateTree((t) => removeLeaf(t, id));
    },
    [mutateTree],
  );
  const handleSplitEditor = useCallback(
    (id: string, side: SplitSide): void => {
      mutateTree((t) => {
        const pane = findPane(t, id);
        if (!pane || pane.kind !== "editor") return t;
        const node: EditorNode = {
          kind: "editor",
          id: `e${Date.now()}-${++editorLeafSeq.current}`,
          path: pane.path,
        };
        newPaneOrigins.current.set(node.id, side);
        setTimeout(
          () => newPaneOrigins.current.delete(node.id),
          PANE_GROW_TTL_MS,
        );
        return insertBeside(t, id, node, side);
      });
    },
    [mutateTree],
  );
  const openEditorFile = useCallback(
    (
      workspaceDir: string,
      path: string,
      anchor: PaneKey | null,
      line?: number,
      col?: number,
    ): void => {
      setExpandedId(null);
      const key = keyForRef(workspaceDir);
      setLayouts((prev) => {
        const cur = prev.get(key) ?? loadLayout(key);
        const tree = cur.tree;
        if (tree && findEditorByPath(tree, path)) return prev;
        const node: EditorNode = {
          kind: "editor",
          id: `e${Date.now()}-${++editorLeafSeq.current}`,
          path,
        };
        return new Map(prev).set(key, {
          ...cur,
          tree: insertPaneAt(tree, node, anchor),
        });
      });
      if (line !== undefined) requestReveal(workspaceDir, path, line, col);
    },
    [],
  );
  const openTerminalFile = useCallback(
    (session: number, path: string, line?: number, col?: number): void => {
      const info = sessionsRef.current.get(session);
      if (!info) return;
      setSideRequest({ kind: "files", root: info.project_dir, path, line, col });
      setScmOpen(true);
      setActiveSurface("side");
    },
    [openEditorFile],
  );
  const openRailInspector = useCallback((paneId: number, tab: ScmTab): void => {
    setActiveId(paneId);
    setScmTab(tab);
    setScmOpen(true);
    setSideExpanded(true);
    setActiveSurface("side");
  }, [setActiveId, setActiveSurface, setSideExpanded]);
  const openTerminalDir = useCallback(
    (path: string, session?: number): void => {
      const root = session == null ? selectedWs : sessionsRef.current.get(session)?.project_dir ?? selectedWs;
      if (root === "all") {
        void showItemInFolder(path).then((res) => {
          if (!res.ok) pushError(res.error);
        });
        return;
      }
      openFilesPaneAt(root, path, null);
    },
    [selectedWs],
  );
  const pickAndOpenFile = useCallback(
    async (workspaceDir: string): Promise<void> => {
      const path = await pickFile(workspaceDir);
      if (path) openEditorFile(workspaceDir, path, null);
    },
    [openEditorFile],
  );

  // The panel reviews the focused pane's workspace in All view, and the
  // selected workspace otherwise — never a session's dir left over from
  // another workspace, which would point the panel at the wrong repo.
  const scmDir = reviewCheckoutDir(sideReview) ?? scmWorkspace(selectedWs, focusedRepoDir(sessions, activeId));
  // Editing or browsing from the panel must land where the user can see it:
  // in All view the focused pane's repo has no visible grid, so reveal it
  // first rather than inserting into a hidden tree.
  const revealWorkspace = useCallback((dir: string): void => {
    if (selectedWsRef.current === "all") setSelectedWs(dir);
  }, []);
  const harness = useHarnessActions({
    conn,
    showWorkspace: setSelectedWs,
    openEditorFile,
    pushError,
  });
  const openScmFile = useCallback(
    (path: string): void => {
      if (!scmDir) return;
      revealWorkspace(scmDir);
      openEditorFile(scmDir, path, null);
    },
    [scmDir, openEditorFile, revealWorkspace],
  );

  useEffect(() => {
    setReviewSessions((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const [dir, entry] of prev) {
        if (!sessions.has(entry.session)) {
          next.delete(dir);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const closeSkills = useCallback(
    (id: string): void => {
      mutateTree((t) => removeLeaf(t, id));
    },
    [mutateTree],
  );
  const toggleScmPanel = useCallback((): void => {
    setScmOpen((open) => !open);
  }, []);
  const resetScmWidth = useCallback((): void => {
    setScmWidth(defaultScmWidth(window.innerWidth));
  }, []);

  const scmProps = useMemo(() => {
    const entry = scmDir ? (reviewSessions.get(scmDir) ?? null) : null;
    const reviewer = entry ? sessions.get(entry.session) : undefined;
    return {
      client:
        conn.kind === "ready" || conn.kind === "reconnecting"
          ? conn.client
          : null,
      dir: scmDir,
      onOpenFileInEditor: openScmFile,
      onOpenUrlInPane: scmDir
        ? (url: string) => {
            revealWorkspace(scmDir);
            openBrowserPane(scmDir, null, url);
          }
        : undefined,
      onReviewPacket: (data: ReviewDiffsData) => {
        if (sideReview) {
          setReviewSessions((current) => new Map(current).set(data.dir, { session: sideReview.id, data }));
          return;
        }
        reviewIntents.current.push({
          projectDir: data.dir,
          data,
          ts: Date.now(),
        });
      },
      review:
        entry && reviewer
          ? {
              session: entry.session,
              codename: reviewer.title,
              data: entry.data,
            }
          : null,
    };
  }, [conn, scmDir, openScmFile, revealWorkspace, openBrowserPane, reviewSessions, sessions, sideReview]);

  const removeWorkspace = useCallback(
    (path: string) => {
      if (conn.kind !== "ready") return;
      const live = [...sessionsRef.current.values()].filter(
        (s) => s.project_dir === path && isLive(s.state),
      ).length;
      const name = workspaces.find((w) => w.path === path)?.name ?? path;
      const unsaved = dirtyBufferPaths(path);
      const parts = [`Close workspace "${name}"?`];
      if (live > 0)
        parts.push(
          `${live} running agent${live > 1 ? "s" : ""} will be stopped.`,
        );
      if (unsaved.length > 0) {
        const shown = unsaved.slice(0, 3).map(basename).join(", ");
        const more =
          unsaved.length > 3 ? ` and ${unsaved.length - 3} more` : "";
        parts.push(
          `${unsaved.length} unsaved file${unsaved.length > 1 ? "s" : ""} (${shown}${more}) will be discarded.`,
        );
      }
      setConfirmRemoveWs({
        path,
        message: parts.join(" "),
        confirmLabel:
          unsaved.length > 0 ? "Discard and close" : "Close workspace",
      });
    },
    [conn, workspaces],
  );

  const dropWorkspaceLocalState = useCallback((path: string): void => {
    setWsColors((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    setWsRenaming((cur) => (cur === path ? null : cur));
    const grids = gridsByWsRef.current.get(path) ?? loadGrids(path);
    const gridKeys = grids.map((g) => gridStorageKey(path, g.id));
    for (const key of gridKeys) {
      const closing = loadLayout(key);
      for (const pane of preorderNonSessionPanes(closing.tree)) {
        if (pane.kind === "browser")
          localStorage.removeItem(tabsStorageKey(pane.id));
      }
      localStorage.removeItem(`tr-layout:${key}`);
    }
    setLayouts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of gridKeys) {
        if (next.delete(key)) changed = true;
      }
      return changed ? next : prev;
    });
    setGridsByWs((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    setSelectedGridByWs((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    localStorage.removeItem(`tr-grids:${path}`);
    localStorage.removeItem(`tr-layout:${path}`);
    dropWorkspaceBuffers(path);
  }, []);

  const confirmRemoveWorkspace = useCallback(() => {
    if (!confirmRemoveWs || conn.kind !== "ready") {
      setConfirmRemoveWs(null);
      return;
    }
    const { path } = confirmRemoveWs;
    conn.client.removeWorkspace(path);
    dropWorkspaceLocalState(path);
    setConfirmRemoveWs(null);
  }, [confirmRemoveWs, conn, dropWorkspaceLocalState]);

  const confirmQuitAndStopDaemon = useCallback(() => {
    setQuitAndStopDaemonConfirm(null);
    void daemonShutdown()
      .catch((err: unknown) => {
        console.warn(
          "houston: daemon_shutdown before quit failed, quitting without stopping it",
          err,
        );
      })
      .finally(() => {
        void appQuit().catch((err: unknown) => {
          console.warn("houston: app_quit failed", err);
        });
      });
  }, []);

  const handleDetach = useCallback(
    (payload: DetachPayload): void => {
      if (conn.kind !== "ready") return;
      const { client } = conn;
      void detachPaneToNewWorkspace(payload, {
        resolveRoot: () =>
          resolveDetachRoot(payload, (session) => client.sessionCwd(session)),
        reparentSession: (session, root) =>
          client.confirmReparentSession(session, root),
        addWorkspace: (root) => client.addWorkspace(root),
        removePaneFromSource: () =>
          mutateTreeAt(payload.sourceWorkspaceId, (t) =>
            removeLeaf(t, payload.paneId),
          ),
        isSourceEmptyAfterDetach: () => {
          const sourceKey = keyForRef(payload.sourceWorkspaceId);
          const cur =
            layoutsRef.current.get(sourceKey) ?? loadLayout(sourceKey);
          const afterRemoval = cur.tree
            ? removeLeaf(cur.tree, payload.paneId)
            : null;
          return isWorkspaceEmptyOfSessionsAndSwarms(
            payload.sourceWorkspaceId,
            payload.sessionId,
            sessionsRef.current.values(),
            [],
            preorderLeaves(afterRemoval).length,
          );
        },
        removeSourceWorkspace: () => {
          client.removeWorkspace(payload.sourceWorkspaceId);
          dropWorkspaceLocalState(payload.sourceWorkspaceId);
        },
        selectWorkspace: (root) => setSelectedWs(root),
        onError: (e) =>
          pushError(
            `Detach failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      });
    },
    [conn, mutateTreeAt, dropWorkspaceLocalState, pushError],
  );

  const newTerminal = useCallback(() => {
    if (conn.kind !== "ready") return;
    if (selectedWs === "all") {
      setShowLauncher(true);
      return;
    }
    setExpandedId(null);
    conn.client.createSession({
      agent: "shell",
      project_dir: selectedWs,
      shell_integration: shellIntegration,
    });
  }, [conn, selectedWs, shellIntegration]);

  const spawnAgentPane = useCallback(
    (agent: AgentKind, profile?: ProfileChoice): void => {
      if (conn.kind !== "ready") return;
      if (selectedWs === "all") return;
      setExpandedId(null);
      conn.client.createSession({
        agent,
        project_dir: selectedWs,
        shell_integration: shellIntegration,
        profile,
      });
    },
    [conn, selectedWs, shellIntegration],
  );

  const [addPanePopover, setAddPanePopover] = useState<{
    anchor: PaneKey | null;
    right: number;
    y: number;
  } | null>(null);
  const openAddPanePopover = useCallback(
    (anchor: PaneKey | null, rect: DOMRect): void => {
      setAddPanePopover({
        anchor,
        right: window.innerWidth - rect.right,
        y: rect.bottom + 4,
      });
    },
    [],
  );
  const toggleTitlebarAddPane = useCallback((): void => {
    setAddPanePopover((cur) => {
      if (cur) return null;
      return { anchor: activeLeaf ?? null, right: 8, y: 40 };
    });
  }, [activeLeaf]);

  const openPaneHandoff = useCallback((source: HandoffSource): void => {
    setPaneHandoff(source);
  }, []);

  const runPaneHandoff = useCallback(
    (agent: AgentKind, packet: string): void => {
      const source = paneHandoff;
      if (!source || conn.kind !== "ready") return;
      const info = sessionsRef.current.get(source.session);
      if (!info) {
        pushError(
          `session ${source.session} is gone — the handoff was not started`,
        );
        setPaneHandoff(null);
        return;
      }
      splitIntents.current.push({
        anchor: source.session,
        side: "right",
        ws: selectedWs,
        projectDir: info.project_dir,
        agent,
        ts: Date.now(),
      });
      conn.client.createSession({
        agent,
        project_dir: info.project_dir,
        cwd_from: source.session,
        prompt: packet,
      });
      setPaneHandoff(null);
    },
    [paneHandoff, conn, selectedWs, pushError],
  );

  const openSshConnect = useCallback(() => {
    if (conn.kind !== "ready") return;
    setSshPrefill(null);
    conn.client.sshProfileList();
    setSshModal(true);
  }, [conn]);

  const openSshReconnect = useCallback(
    (id: number) => {
      if (conn.kind !== "ready") return;
      const spec = sessionsRef.current.get(id)?.ssh_host ?? "";
      const at = spec.lastIndexOf("@");
      const user = at > 0 ? spec.slice(0, at) : "";
      const rest = at > 0 ? spec.slice(at + 1) : spec;
      const colon = rest.lastIndexOf(":");
      const port = colon > 0 ? Number(rest.slice(colon + 1)) : undefined;
      const host = colon > 0 ? rest.slice(0, colon) : rest;
      setSshPrefill({ host, port, user });
      conn.client.sshProfileList();
      setSshModal(true);
    },
    [conn],
  );

  const sshConnect = useCallback(
    (params: SshConnectParams) => {
      if (conn.kind !== "ready") return;
      const request = ++sshRequestSeq.current;
      conn.client.sshConnect({ request, ...params, cols: 80, rows: 24 });
      setSshModal(false);
    },
    [conn],
  );

  const sshSaveProfile = useCallback(
    (profile: SshProfile) => {
      if (conn.kind === "ready") conn.client.sshProfileSave(profile);
    },
    [conn],
  );

  const sshSetCredential = useCallback(
    (profile: string, password: string) => {
      if (conn.kind === "ready")
        conn.client.sshCredentialSet(profile, password);
    },
    [conn],
  );

  const sshClearCredential = useCallback(
    (profile: string) => {
      if (conn.kind === "ready") conn.client.sshCredentialClear(profile);
    },
    [conn],
  );

  const sshLoadConfigHosts = useCallback(() => {
    if (conn.kind === "ready") conn.client.sshConfigHosts();
  }, [conn]);

  const sshDeleteProfile = useCallback(
    (name: string) => {
      if (conn.kind === "ready") conn.client.sshProfileDelete(name);
    },
    [conn],
  );

  const answerHostKey = useCallback(
    (accept: boolean) => {
      const head = hostKeyQueue[0];
      if (!head) return;
      if (conn.kind !== "ready") {
        pushError(
          `Could not answer host-key prompt for ${head.host}:${head.port} — connection not ready`,
        );
        return;
      }
      conn.client.sshHostKeyAnswer(head.request, accept);
      setHostKeyQueue((q) => removeHostKeys(q, [head.request]));
    },
    [conn, hostKeyQueue, pushError],
  );

  const rejectRemainingHostKeys = useCallback(() => {
    const { toReject } = planRejectRemaining(hostKeyQueue);
    if (toReject.length === 0) return;
    if (conn.kind !== "ready") {
      pushError(
        `Could not reject ${toReject.length} queued host-key prompt(s) — connection not ready`,
      );
      return;
    }
    for (const p of toReject) conn.client.sshHostKeyAnswer(p.request, false);
    const ids = toReject.map((p) => p.request);
    setHostKeyQueue((q) => removeHostKeys(q, ids));
  }, [conn, hostKeyQueue, pushError]);

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement;
      if (!t.closest(".side-panel")) setActiveSurface("grid");
      const paneEl = t.closest(".pane");
      const paneKeyAttr = paneEl?.getAttribute("data-panekey") ?? null;
      const sessionPane = paneKeyAttr !== null && /^\d+$/.test(paneKeyAttr);
      if (!sessionPane) setActiveId(null);
      setActiveLeaf(paneEl && !sessionPane ? paneKeyAttr : null);
      if (!t.closest(".add-pane-popover")) setAddPanePopover(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  useBrowserFocus((id) => {
    const tab = loadSideState(sideWorkspace).tabs.find((tab) => tab.kind === "browser" && tab.id === id);
    if (tab?.kind === "browser") { setActiveSurface("side"); setActiveId(null); return; }
    setActiveSurface("grid");
    setActiveId(null);
    const tree = currentTreeRef.current;
    setActiveLeaf(tree && findPane(tree, id) ? id : null);
  });
  const revealGridBrowser = (workspace: string, surfaceId: string): boolean => {
    for (const grid of gridsByWsRef.current.get(workspace) ?? loadGrids(workspace)) {
      const key = gridStorageKey(workspace, grid.id);
      const layout = layoutsRef.current.get(key) ?? loadLayout(key);
      const tree = layout.tree;
      if (!tree || findPane(tree, surfaceId)?.kind !== "browser") continue;
      handleSelectGrid(workspace, grid.id);
      const stack = findStackContaining(tree, surfaceId);
      if (stack) setLayouts((current) => new Map(current).set(key, { ...layout, tree: setActiveStackTab(tree, stack.id, surfaceId) }));
      setSideExpanded(false);
      setExpandedId(null);
      setActiveLeaf(surfaceId);
      setActiveSurface("grid");
      return true;
    }
    return false;
  };
  useBrowserOpenRequest((workspaceDir, url, surfaceId) => {
    if (!workspacesRef.current.some((w) => w.path === workspaceDir)) return;
    routeBrowserOpenRequest(workspaceDir, url, surfaceId, revealGridBrowser, (workspace, requestedUrl) => openBrowserPane(workspace, null, requestedUrl));
  });

  const voiceClient = conn.kind === "ready" ? conn.client : null;
  const voiceEnabled = voiceSettings?.enabled === true;
  const voiceCaptureMode = voiceSettings?.capture_mode ?? "hold";
  useEffect(() => {
    if (!voiceClient || !voiceEnabled) {
      configureDictation(null);
      clearVoiceIndicators();
      return;
    }
    configureDictation({
      enabled: true,
      captureMode: voiceCaptureMode,
      start: (session) => {
        dictationTargetRef.current = session;
        voiceClient.voiceStart(session);
      },
      stop: (session) => voiceClient.voiceStop(session),
    });
    return () => configureDictation(null);
  }, [voiceClient, voiceEnabled, voiceCaptureMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      if (shouldIgnoreInputKey(target, e, settings)) return;
      if (target.isContentEditable) return;
      if (paletteOpen) return;
      // Prefix layer: one-shot. Whatever key follows the prefix resolves once, then
      // the layer is down. Esc only cancels it and never reaches the pane.
      const layerArmed = prefixLayer.isArmed();
      if (layerArmed && isModifierKeydown(e)) return;
      if (layerArmed) prefixLayer.disarm();
      if (layerArmed && resolveMatch(escapeShortcut, keymapOverrides)(e)) {
        e.preventDefault();
        return;
      }
      if (
        !layerArmed &&
        resolveGlobalMatch(prefixShortcut, keymapOverrides)(e)
      ) {
        e.preventDefault();
        prefixLayer.arm();
        return;
      }
      if (resolveMatch(escapeShortcut, keymapOverrides)(e) && paneHandoff) {
        e.preventDefault();
        setPaneHandoff(null);
        return;
      }
      const zoomStep = matchZoomStep(e, keymapOverrides);
      if (zoomStep) {
        e.preventDefault();
        (zoomStep.target === "zoom" ? changeZoom : changeFont)(zoomStep.step);
        return;
      }
      if (focusedSurfaceOwnsKey(activeSurface, e, activeId, layerArmed)) return;
      if (resolveMatch(escapeShortcut, keymapOverrides)(e)) {
        if (shortcutSheet) setShortcutSheet(false);
        else if (settings) setSettings(false);
        else if (railView !== null) setRailView(null);
        else if (composer) setComposer(null);
        else if (showLauncher) {
          if (workspaces.length > 0) setShowLauncher(false);
        } else setExpandedId(null);
        return;
      }
      if (resolveGlobalMatch(settingsShortcut, keymapOverrides)(e)) {
        e.preventDefault();
        setSettings((cur) => !cur);
        return;
      }
      if (resolveGlobalMatch(usageShortcut, keymapOverrides)(e)) {
        e.preventDefault();
        setSettings(false);
        setRailView("usage");
        return;
      }
      if (
        paneHandoff ||
        settings ||
        railView !== null ||
        composer ||
        shortcutSheet ||
        confirmRemoveWs ||
        sshModal ||
        hostKeyPrompt
      )
        return;
      if (resolveGlobalMatch(toggleSidebar, keymapOverrides)(e)) {
        e.preventDefault();
        setSidebarRail((cur) => !cur);
      } else if (resolveGlobalMatch(togglePanel, keymapOverrides)(e)) {
        e.preventDefault();
        toggleTitlebarAddPane();
      } else if (resolveGlobalMatch(browserFocusUrl, keymapOverrides)(e)) {
        if (focusSideBrowserUrl(activeSurface, e)) return;
        const tree = currentTreeRef.current;
        const active =
          activeLeaf !== null && tree ? findPane(tree, activeLeaf) : null;
        if (active?.kind === "browser") {
          e.preventDefault();
          setFocusBrowserUrl((n) => n + 1);
        }
      } else if (
        resolveGlobalMatch(closeWorkspaceShortcut, keymapOverrides)(e)
      ) {
        e.preventDefault();
        if (selectedWs !== "all") removeWorkspace(selectedWs);
      } else if (
        resolveGlobalMatch(renameWorkspaceShortcut, keymapOverrides)(e)
      ) {
        if (selectedWs !== "all") {
          e.preventDefault();
          setSidebarRail(false);
          setWsRenaming(selectedWs);
        }
      } else if (resolveGlobalMatch(selectPane, keymapOverrides)(e)) {
        const id = orderedIds[Number(e.key) - 1];
        if (id !== undefined) {
          if (currentTree) {
            const container = findStackContaining(currentTree, id);
            if (container)
              mutateTree((t) => setActiveStackTab(t, container.id, id));
          }
          setActiveId(id);
        }
      } else if (resolveGlobalMatch(newTerminalShortcut, keymapOverrides)(e)) {
        newTerminal();
      } else if (resolveGlobalMatch(openFileShortcut, keymapOverrides)(e)) {
        if (selectedWs !== "all") void pickAndOpenFile(selectedWs);
      } else if (
        resolveGlobalMatch(newBrowserPaneShortcut, keymapOverrides)(e)
      ) {
        if (!workspacesEmptyOpen && selectedWs !== "all")
          openBrowserPane(selectedWs, null);
      } else if (resolveGlobalMatch(expandPane, keymapOverrides)(e)) {
        const target = activeLeaf ?? orderedIds[0] ?? null;
        setExpandedId((cur) => (cur === null ? target : null));
      } else if (splitSideFor(e, keymapOverrides) !== null) {
        const side = splitSideFor(e, keymapOverrides) as SplitSide;
        const target = workspacesEmptyOpen
          ? null
          : ((typeof expandedId === "number" ? expandedId : null) ??
            orderedIds.find((id) =>
              isLive(sessions.get(id)?.state ?? "exited"),
            ) ??
            null);
        if (target !== null) handleSplitFromLayout(target, side);
      } else if (resolveGlobalMatch(tidyGrid, keymapOverrides)(e)) {
        if (paneCount > 1) tidyPanes();
      } else if (resolveGlobalMatch(equalizePanes, keymapOverrides)(e)) {
        if (paneCount > 1) equalizePanesNow();
      } else if (resolveGlobalMatch(focusNextPane, keymapOverrides)(e)) {
        focusAdjacentPane(1);
      } else if (resolveGlobalMatch(focusPrevPane, keymapOverrides)(e)) {
        focusAdjacentPane(-1);
      } else if (resolveGlobalMatch(movePaneNext, keymapOverrides)(e)) {
        movePaneBy(1);
      } else if (resolveGlobalMatch(movePanePrev, keymapOverrides)(e)) {
        movePaneBy(-1);
      } else if (resolveGlobalMatch(toggleGit, keymapOverrides)(e)) {
        toggleScmPanel();
      } else if (
        resolveGlobalMatch(shortcutSheetShortcut, keymapOverrides)(e)
      ) {
        setShortcutSheet(true);
      } else if (resolveGlobalMatch(wsNext, keymapOverrides)(e)) {
        e.preventDefault();
        stepWorkspace(1);
      } else if (resolveGlobalMatch(wsPrev, keymapOverrides)(e)) {
        e.preventDefault();
        stepWorkspace(-1);
      } else if (
        layerArmed &&
        resolveGlobalMatch(wsLast, keymapOverrides)(e)
      ) {
        e.preventDefault();
        selectLastWorkspace();
      } else if (resolveGlobalMatch(gridNext, keymapOverrides)(e)) {
        e.preventDefault();
        stepGrid(1);
      } else if (resolveGlobalMatch(gridPrev, keymapOverrides)(e)) {
        e.preventDefault();
        stepGrid(-1);
      } else if (
        layerArmed &&
        resolveGlobalMatch(paletteLayer, keymapOverrides)(e)
      ) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (
        resolveGlobalMatch(commandPaletteShortcut, keymapOverrides)(e)
      ) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    orderedIds,
    currentTree,
    mutateTree,
    settings,
    composer,
    showLauncher,
    workspacesEmptyOpen,
    workspaces,
    shortcutSheet,
    paletteOpen,
    confirmRemoveWs,
    activeId,
    activeLeaf,
    expandedId,
    changeZoom,
    changeFont,
    selectedWs,
    removeWorkspace,
    newTerminal,
    openBrowserPane,
    toggleScmPanel,
    handleSplitFromLayout,
    sessions,
    pickAndOpenFile,
    paneHandoff,
    sshModal,
    hostKeyQueue,
    keymapOverrides,
    toggleTitlebarAddPane,
    paneCount,
    tidyPanes,
    equalizePanesNow,
    activeSurface,
    focusAdjacentPane,
    movePaneBy,
    stepWorkspace,
    selectLastWorkspace,
    stepGrid,
  ]);

  const visiblePaneIds = useMemo(() => new Set(preorderSessions(currentTree)), [currentTree]);
  const getNotificationContext = useCallback((session: SessionInfo): OrchestrationNotificationContext => {
    const workspace = workspaces.find((entry) => entry.path === session.project_dir);
    const grid = gridsFor(session.project_dir).find((entry) => {
      const key = gridStorageKey(session.project_dir, entry.id);
      const tree = layouts.get(key)?.tree ?? warmLayouts.get(key)?.tree ?? loadLayout(key).tree;
      return preorderSessions(tree).includes(session.id);
    });
    const agent = session.detected_agent ?? session.agent;
    const agentName = agent === 'claude' ? 'Claude Code' : agent === 'opencode' ? 'OpenCode' : agent[0].toUpperCase() + agent.slice(1);
    return {
      agent: agentName,
      workspace: workspace?.name ?? session.project_dir,
      grid: grid?.name ?? 'Main grid'
    };
  }, [gridsFor, layouts, warmLayouts, workspaces]);

  if (conn.kind === "connecting")
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-[14px] text-[var(--text-muted)]">
        connecting to houston-core…
      </div>
    );
  if (conn.kind === "failed")
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-[14px] text-[var(--danger)] px-[20%] text-center">
        <p>{conn.error}</p>
        <div className="flex gap-2">
          <button
            className={`btn ${BTN_PRIMARY}`}
            onClick={() => {
              setConn({ kind: "connecting" });
              setRetryNonce((n) => n + 1);
            }}
          >
            Retry
          </button>
          <button
            className="border-0 bg-transparent hover:bg-[var(--card-hover)]"
            onClick={recordAndReload}
          >
            Reload app
          </button>
        </div>
      </div>
    );
  const client = conn.client;
  const connected = conn.kind === "ready";
  const activeLaunchPreview = visibleLaunchPreview(composer, launchPreview);

  const renameWorkspaceSubmit = (path: string, name: string): void => {
    setWsRenaming(null);
    const trimmed = name.trim();
    const current = workspaces.find((w) => w.path === path)?.name;
    if (!trimmed || trimmed === current) return;
    client.renameWorkspace(path, trimmed);
  };

  const wsName = workspaces.find((w) => w.path === selectedWs)?.name ?? null;

  const handleTitlebarMouseDown = (e: React.MouseEvent): void => {
    if (!isTitlebarDragEligible(e)) return;
    void startDragging().catch((err: unknown) => {
      console.warn("houston: startDragging failed", err);
    });
  };
  const handleTitlebarDoubleClick = (e: React.MouseEvent): void => {
    if (isBareTitlebarTarget(e.target)) {
      void windowControl("maximize").catch((err: unknown) => {
        console.warn("houston: windowControl(maximize) failed", err);
      });
    }
  };

  const selectNavRow = (row: RailView): void => {
    setSettings(false);
    setRailView(row);
    setComposer(null);
    setShowLauncher(false);
  };

  const paletteActions: PaletteActions = {
    workspaceActions,
    runWorkspaceAction: workspaceActionState.run,
    newTerminal,
    insertPane: (kind) => {
      if (kind === "browser" && selectedWs !== "all")
        openBrowserPane(selectedWs, null);
    },
    splitPane:
      activeId !== null
        ? () => handleSplitFromLayout(activeId, "right")
        : undefined,
    newGrid: () => {
      if (selectedWs !== "all") handleAddGrid(selectedWs);
    },
    closePane:
      activeId !== null ? () => client.closeSession(activeId) : undefined,
    toggleGitPane: () => {
      toggleScmPanel();
    },
    spawnAgent: (agent) => spawnAgentPane(agent),
    openTasks: (compose) => openSideTasks(compose === true),
    focusedSelection: () => terminalSelection(activeId),
    newTaskFromSelection: (selection) => {
      if (selectedWs === "all") return;
      // The draft helper rides with the Tasks formatting module, which stays off the boot path.
      void import("./components/tasks/format").then(({ taskDraftFromSelection }) => {
        const draft = taskDraftFromSelection(selection);
        if (draft !== null) openSideTasks(false, undefined, draft);
      });
    },
    toggleSidebarRail: () => setSidebarRail((cur) => !cur),
    toggleChromeTheme: () =>
      setChromeTheme(chromeTheme === "graphite" ? "paper" : "graphite"),
    openAddPanePopover: toggleTitlebarAddPane,
    setGridLayout: (cols) => resetLayout(cols),
    tidyPanes: paneCount > 1 ? tidyPanes : undefined,
    equalizePanes: paneCount > 1 ? equalizePanesNow : undefined,
    openShortcutSheet: () => setShortcutSheet(true),
    windowMinimize: () =>
      void windowControl("minimize").catch((err: unknown) => {
        console.warn("houston: windowControl(minimize) failed", err);
      }),
    windowMaximize: () =>
      void windowControl("maximize").catch((err: unknown) => {
        console.warn("houston: windowControl(maximize) failed", err);
      }),
    windowClose: () =>
      void windowControl("close").catch((err: unknown) => {
        console.warn("houston: windowControl(close) failed", err);
      }),
    quitAndStopDaemon: () => {
      void daemonStatus().then(
        (status) =>
          setQuitAndStopDaemonConfirm({ message: stopConfirmCopy(status) }),
        () =>
          setQuitAndStopDaemonConfirm({ message: stopConfirmCopy(null) }),
      );
    },
    selectNavRow,
    switchWorkspace: (path) => {
      setSelectedWs(path);
      setShowLauncher(false);
    },
    switchGrid: handleSelectGrid,
    focusPane,
    restartPane: (id) => client.respawnSession(id, undefined, null, undefined, undefined, false),
    ...paletteNavActions({
      workspaceCount: orderedWorkspaces.length,
      lastWorkspace: lastWorkspace(),
      selectedWs,
      gridsFor,
      stepWorkspace,
      selectLastWorkspace,
      stepGrid,
    }),
  };

  return (
    <SessionsStoreContext.Provider value={sessionsStore}>
      <SessionEffects
        connection={conn.kind}
        workspaces={workspaces}
        onFocusPane={focusPane}
        rosterRevision={rosterRevision}
        desktopNotificationMode={desktopNotificationMode}
        inAppNotifications={inAppNotifications}
        visiblePaneIds={visiblePaneIds}
        getNotificationContext={getNotificationContext}
        pushNotificationNotice={orchestrationNotices.push}
        onDesktopDelivery={(allowed, error) => setDesktopNotificationDelivery({ allowed, error })}
      />
    <TerminalTuningContext.Provider value={terminalTuning}>
      <KeymapOverridesContext.Provider value={keymapOverrides}>
      <TagsContext.Provider value={tags}>
        <Shell
          chromeTheme={chromeTheme}
          onBackgroundUnavailable={onBackgroundUnavailable}
          railWidth={railWidth}
          railCollapsed={sidebarRail}
        >
          <RailResizeHandle
            width={railWidth}
            collapsed={sidebarRail}
            onChange={setRailWidth}
            onCollapse={() => setSidebarRail(true)}
          />
          {!sidebarRail && (
            <Sidebar
              className="[grid-area:rail]"
              onHeadMouseDown={handleTitlebarMouseDown}
              onHeadDoubleClick={handleTitlebarDoubleClick}
              workspaces={orderedWorkspaces}
              sessions={[...sessions.values()]}
              selected={workspacesEmptyOpen ? "" : selectedWs}
              customColors={wsColors}
              colorIndexByPath={wsColorIndex}
              onReorderWorkspace={(fromPath, toIndex) =>
                setWsOrder(
                  reorderPinned(orderedWorkspaces, wsPinnedSet, fromPath, toIndex),
                )
              }
              pinnedWorkspaces={wsPinnedSet}
              onTogglePinWorkspace={(path) =>
                setWsPinned((prev) =>
                  prev.includes(path)
                    ? prev.filter((p) => p !== path)
                    : [...prev, path],
                )
              }
              renaming={wsRenaming}
              onSelect={(key) => {
                setSelectedWs(key);
                setShowLauncher(false);
              }}
              onAddWorkspace={() => {
                void addWorkspaceFromPicker();
              }}
              chromeTheme={chromeTheme}
              onToggleChromeTheme={(origin) =>
                revealThemeFromClick(origin, () =>
                  setChromeTheme(chromeTheme === "graphite" ? "paper" : "graphite"),
                )
              }
              updateVersion={offeredUpdate(update, dismissedUpdate)}
              harnessAttention={harnessAttention}
              taskTurnCount={taskTurnCount}
              onRemoveWorkspace={removeWorkspace}
              onOpenExternalError={pushError}
              onRenameStart={(path) => {
                setSidebarRail(false);
                setWsRenaming(path);
              }}
              onRenameSubmit={renameWorkspaceSubmit}
              onRenameCancel={() => setWsRenaming(null)}
              onChangeColor={(path, color) =>
                setWsColors((prev) => ({ ...prev, [path]: color }))
              }
              onSshConnect={openSshConnect}
              railClient={conn.kind === "ready" ? conn.client : null}
              checkoutBranches={checkout.chips}
              onOpenInspector={openRailInspector}
              gridsByWorkspace={gridsByWorkspace}
              tags={tags}
              onSetGridTags={(path, gridId, tagIds) =>
                setGridsByWs((prev) =>
                  new Map(prev).set(path, setGridTags(path, gridId, tagIds)),
                )
              }
              onTagCreate={(name, color) => {
                if (conn.kind === "ready") conn.client.tagCreate(name, color);
              }}
              onTagUpdate={(tag, name, color) => {
                if (conn.kind === "ready") conn.client.tagUpdate(tag, name, color);
              }}
              onTagDelete={(tag) => {
                if (conn.kind === "ready") conn.client.tagDelete(tag);
              }}
              selectedGridId={
                workspacesEmptyOpen ? null : activeGridId(selectedWs)
              }
              onSelectGrid={handleSelectGrid}
              onAddGrid={handleAddGrid}
              onNewWorkspaceSession={(path) => {
                setSelectedWs(path);
                setShowLauncher(false);
                setComposer("new-grid");
              }}
              onRenameGrid={handleRenameGrid}
              onRemoveGrid={handleRemoveGrid}
              onHideRail={() => setSidebarRail(true)}
              onOpenSettings={() => {
                setSettings((cur) => !cur);
              }}
              onOpenPalette={() => setPaletteOpen(true)}
              paletteChord={effectiveLabel(
                commandPaletteShortcut,
                keymapOverrides,
              )}
            />
          )}
          <header
            data-custom={customChrome.dataCustom}
            {...materialAttrs("shell")}
            className={`relative [grid-area:topbar] grid grid-cols-[minmax(0,1fr)_auto] items-center h-[var(--h-top)] [-webkit-app-region:drag] select-none ${MATERIAL_CLS.shell} ${
              customChrome.custom ? "shadow-[var(--glass-topbar-shadow)]" : ""
            }`}
            onMouseDown={handleTitlebarMouseDown}
            onDoubleClick={handleTitlebarDoubleClick}
          >
            <div className="flex items-center gap-1.5 min-w-0 pl-2.5">
              <SettingsBreadcrumb open={settings} section={settingsSectionLabel()} />
              {}
              {sidebarRail && (
                <Tooltip label="Show sidebar (Ctrl+B)">
                  <button
                    type="button"
                    className={`relative ${BTN_ICO} [-webkit-app-region:no-drag]`}
                    aria-label="Show sidebar"
                    onClick={() => setSidebarRail(false)}
                  >
                    <Icon glyph={IconPanelLeft} role="ui" />
                  </button>
                </Tooltip>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1 mr-1">
              <VoiceMicChip
                paneTitle={(session) =>
                  sessionsRef.current.get(session)?.title ?? null
                }
              />
              <Tooltip
                label={
                  paneCount > 1
                    ? "Tidy panes into a balanced grid"
                    : "Open a second pane to tidy the grid"
                }
              >
                <button
                  className={`btn ${BTN_ICO} [-webkit-app-region:no-drag]`}
                  aria-label="Tidy panes"
                  disabled={paneCount < 2}
                  onClick={tidyPanes}
                >
                  <Icon glyph={IconGrid} role="ui" />
                </button>
              </Tooltip>
              <SourceControlToggle
                open={scmOpen}
                chord={effectiveLabel(toggleGit, keymapOverrides)}
                onToggle={toggleScmPanel}
              />
              <WindowControls
                className="ml-[var(--space-2-5)] -mr-1"
                layout={buttonLayout}
                maximized={maximized}
                onClose={() =>
                  void windowControl("close").catch((err: unknown) => {
                    console.warn("houston: windowControl(close) failed", err);
                  })
                }
                onMinimize={() =>
                  void windowControl("minimize").catch((err: unknown) => {
                    console.warn(
                      "houston: windowControl(minimize) failed",
                      err,
                    );
                  })
                }
                onMaximize={() =>
                  void windowControl("maximize").catch((err: unknown) => {
                    console.warn(
                      "houston: windowControl(maximize) failed",
                      err,
                    );
                  })
                }
              />
            </div>
          </header>

          {conn.kind === "reconnecting" && (
            <Suspense fallback={null}>
              <ReconnectBanner
                since={conn.since}
                error={conn.error}
                onRetry={() => {
                  clearTimeout(retryTimerRef.current);
                  reconnectRef.current();
                }}
              />
            </Suspense>
          )}

          {}
          {}
          <main
            data-custom={customChrome.dataCustom}
            className={`grid-region ${scmOpen ? "with-side" : ""} [grid-area:grid] min-w-0 min-h-0 flex flex-col relative overflow-hidden`}
          >
            <NoticeStack
              anchor="workspace-top"
              label="Workspace notices"
              store={appNotices}
            />
            <NoticeStack
              anchor="workspace-top-right"
              label="Agent notifications"
              store={orchestrationNotices}
            />

            <div className="side-panel-row flex-1 min-w-0 min-h-0 flex">
              <div
                aria-hidden={gridSurfaceHidden || undefined}
                inert={gridSurfaceHidden}
                onPointerDownCapture={() => setActiveSurface("grid")}
                onFocusCapture={() => setActiveSurface("grid")}
                className={`grid-slot contents ${gridSurfaceHidden ? "grid-hidden invisible" : ""}`}
              >
              {selectedWs === "all" ? (
                currentTree ? (
                  <LayoutView
                    tree={currentTree}
                    sessions={sessions}
                    branches={checkout.chips}
                    branchNotes={checkout.notes}
                    roster={paneRoster}
                    gridSessionIds={mountedGridSessionIds}
                    onMoveChildToGrid={moveChildToGrid}
                    onReturnChildToRoster={returnChildToRoster}
                    onFocusPane={focusPane}
                    viewAll
                    client={client}
                    theme={theme}
                    fontSize={fontSize}
                    fontFamily={fontFamily}
                    shiftEnterNewline={shiftEnterNewline}
                    openLinksInPane={openLinksInPane}
                    onOpenUrlInPane={undefined}
                    copyOnSelect={copyOnSelect}
                    stripBoxGlyphs={stripBoxGlyphs}
                    activeId={activeId}
                    activeLeafId={activeLeaf}
                    connected={connected}
                    expandedId={expandedIn(currentTree)}
                    gridHidden={gridSurfaceHidden}
                    registerOutput={registerOutput}
                    shellIntegration={shellIntegration}
                    workspaceDir={selectedWs}
                    onReconnectSsh={openSshReconnect}
                    onActivate={(id) => setActiveId(id)}
                    onExpand={handleExpand}
                    onZoom={changeFont}
                    onShellZoom={changeZoom}
                    onSplit={handleSplitFromLayout}
                    onAddPane={undefined}
                    onMove={handleMove}
                    onSwap={handleSwap}
                    onResize={handleResize}
                    onDetach={undefined}
                    onCloseBrowser={closeBrowser}
                    onBrowserNavigate={browserNavigate}
                    onCloseEditor={closeEditor}
                    onSplitEditor={handleSplitEditor}
                    newPaneOrigins={newPaneOrigins.current}
                    onHandoff={openPaneHandoff}
                    onSwapAdjacent={
                      paneCount > 1 ? swapPaneAdjacent : undefined
                    }
                    onOpenFile={openTerminalFile}
                    onOpenDir={openTerminalDir}
                    onSendToTerminal={pickerAvailable ? sendPickerToAgent : undefined}
                    sendToTerminalLabel={pickerTargetLabel}
                    onNativeError={pushError}
                    onRunSkill={canRunSkill ? runSkill : undefined}
                    skillDistribution={skillDistribution}
                    onCloseSkills={closeSkills}
                    onCloseFiles={closeFiles}
                    focusUrlRequest={focusBrowserUrl}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-[var(--text-faint)] gap-[5px]">
                    No terminals here. Press{" "}
                    <b className="text-[var(--text-muted)]">t</b> to open one,
                    or <b className="text-[var(--text-muted)]">b</b> for a
                    browser pane.
                  </div>
                )
              ) : (
                <>
                  {orderedWorkspaces.flatMap((w) => {
                    const wsSelected = w.path === selectedWs;
                    const grids = gridsFor(w.path);
                    const active = activeGridId(w.path);
                    const warmGrids = wsSelected
                      ? grids
                      : grids.filter((g) => g.id === active);
                    return warmGrids.map((g) => {
                      const gridSelected = wsSelected && g.id === active;
                      const key = gridStorageKey(w.path, g.id);
                      const tree = gridSelected
                        ? currentTree
                        : (warmLayouts.get(key)?.tree ?? null);
                      return (
                        <div
                          key={key}
                          className={gridSelected ? "contents" : "hidden"}
                          data-testid={
                            gridSelected ? undefined : "warm-workspace-grid"
                          }
                          data-workspace={w.path}
                          data-grid={g.id}
                        >
                          {tree ? (
                            <LayoutView
                              tree={tree}
                              warm={!gridSelected}
                              sessions={sessions}
                              branches={checkout.chips}
                    branchNotes={checkout.notes}
                              roster={paneRoster}
                              gridSessionIds={mountedGridSessionIds}
                              onMoveChildToGrid={moveChildToGrid}
                              onReturnChildToRoster={returnChildToRoster}
                              onFocusPane={focusPane}
                              viewAll={false}
                              client={client}
                              theme={theme}
                              fontSize={fontSize}
                              fontFamily={fontFamily}
                              shiftEnterNewline={shiftEnterNewline}
                              openLinksInPane={openLinksInPane}
                              onOpenUrlInPane={(url: string) =>
                                openBrowserPane(w.path, null, url)
                              }
                              copyOnSelect={copyOnSelect}
                              stripBoxGlyphs={stripBoxGlyphs}
                              activeId={gridSelected ? activeId : null}
                              activeLeafId={gridSelected ? activeLeaf : null}
                              connected={connected}
                              expandedId={
                                gridSelected ? expandedIn(tree) : null
                              }
                              gridHidden={gridSurfaceHidden}
                              registerOutput={registerOutput}
                              shellIntegration={shellIntegration}
                              workspaceDir={w.path}
                              onReconnectSsh={openSshReconnect}
                              onActivate={(id) => setActiveId(id)}
                              onExpand={handleExpand}
                              onZoom={changeFont}
                              onShellZoom={changeZoom}
                              onSplit={handleSplitFromLayout}
                              onAddPane={
                                gridSelected ? openAddPanePopover : undefined
                              }
                              onMove={handleMove}
                              onSwap={handleSwap}
                              onStackWith={
                                gridSelected ? handleStackWith : undefined
                              }
                              onSelectStackTab={(stackId, k) =>
                                handleSelectStackTab(w.path, stackId, k)
                              }
                              onUnstack={(k) => handleUnstack(w.path, k)}
                              onResize={handleResize}
                              onDetach={handleDetach}
                              onCloseBrowser={closeBrowser}
                              onBrowserNavigate={browserNavigate}
                              onCloseEditor={closeEditor}
                              onSplitEditor={handleSplitEditor}
                              newPaneOrigins={newPaneOrigins.current}
                              onHandoff={openPaneHandoff}
                              onSwapAdjacent={
                                paneCount > 1 ? swapPaneAdjacent : undefined
                              }
                              onOpenFile={openTerminalFile}
                              onOpenDir={openTerminalDir}
                              onSendToTerminal={pickerAvailable ? sendPickerToAgent : undefined}
                              sendToTerminalLabel={pickerTargetLabel}
                              onNativeError={pushError}
                              onRunSkill={canRunSkill ? runSkill : undefined}
                    skillDistribution={skillDistribution}
                              onCloseSkills={closeSkills}
                              onCloseFiles={closeFiles}
                              focusUrlRequest={
                                gridSelected ? focusBrowserUrl : undefined
                              }
                              launchPreview={gridSelected ? activeLaunchPreview : undefined}
                            />
                          ) : gridSelected ? (
                            <div className="relative flex-1 min-w-0 min-h-0">
                              <WorkspaceEmpty
                                onNewSession={() => setComposer("current-grid")}
                                onTerminal={newTerminal}
                                onBrowser={() => openBrowserPane(w.path, null)}
                                actions={workspaceActionsFor(w.path)}
                                keymapOverrides={keymapOverrides}
                                onRunAction={workspaceActionState.run}
                                onSaveAction={workspaceActionState.save}
                                onDeleteAction={workspaceActionState.remove}
                              />
                              {activeLaunchPreview && (
                                <Suspense fallback={null}>
                                  <LaunchGridPreview tree={null} slots={activeLaunchPreview.slots} target={activeLaunchPreview.target} sessions={sessions} />
                                </Suspense>
                              )}
                            </div>
                          ) : null}
                        </div>
                      );
                    });
                  })}
                </>
              )}
              </div>
              <LaunchComposerDock
                composer={composer}
                workspace={selectedWs}
                settingsOpen={Boolean(settings)}
                railOpen={railView !== null}
                workspaceName={basename(selectedWs)}
                gridName={() => gridsFor(selectedWs).find((grid) => grid.id === activeGridId(selectedWs))?.name}
                client={client}
                connected={connected}
                onPreviewChange={handleLaunchPreview}
                onLaunch={launchSessions}
                onClose={() => { setComposer(null); setLaunchPreview(null) }}
              />
              {(scmOpen || loadSideState(sideWorkspace).tabs.some((tab) => tab.kind === "browser")) && (
                <SidePanelIntegration
                  expanded={sideExpanded}
                  onExpanded={setSideExpanded}
                  focused={activeSurface === "side"}
                  closed={!scmOpen}
                  onSendToTerminal={pickerAvailable ? sendPickerToAgent : undefined}
                  sendToTerminalLabel={pickerTargetLabel}
                  selectedWorkspace={sideWorkspace}
                  activeId={activeId}
                  sessions={sessions}
                  request={sideRequest}
                  reviewChild={sideReview}
                  onSurface={setActiveSurface}
                  onFocusPane={focusPane}
                  onRevealWorkspace={revealWorkspace}
                  onOpenEditor={openEditorFile}
                  onReviewChild={(child) => { setSideReview(child); setScmTab("changes"); setSideRequest(null); }}
                  onTaskStartRequested={handleTaskStartRequested}
                  workspaces={workspaces}
                  dir={scmProps.dir}
                  client={scmProps.client}
                  width={scmWidth}
                  onWidth={setScmWidth}
                  onResetWidth={resetScmWidth}
                  tab={scmTab}
                  onTab={setScmTab}
                  onOpenFileInEditor={scmProps.onOpenFileInEditor}
                  onOpenUrlInPane={scmProps.onOpenUrlInPane}
                  onReviewPacket={scmProps.onReviewPacket}
                  review={scmProps.review}
                  hiddenByOverlay={gridHidden}
                />
              )}
            </div>

            {settings || railView !== null ? (
              <div className="content-region absolute inset-0 flex z-[var(--z-leaf)]">
                <SurfaceBoundary label={railView ?? "Settings"}>
                  {railView === "tasks" ? (
                    <Suspense fallback={<div className="flex-1" />}>
                      <TasksSurface
                        client={conn.kind === "ready" ? conn.client : null}
                        workspace={selectedWs}
                        workspaces={workspaces.map((w) => ({ path: w.path, name: w.name }))}
                        sessions={sessions}
                        now={Date.now()}
                        onStartRequested={handleTaskStartRequested}
                        onOpenSession={(sessionId) => {
                          setRailView(null);
                          focusPane(sessionId);
                        }}
                        onReview={(session) => {
                          setRailView(null);
                          setSideReview(session);
                          setScmTab("changes");
                          setSideRequest(null);
                        }}
                        onOpenExternal={(url) => void openExternal(url)}
                      />
                    </Suspense>
                  ) : railView === "skills" ? (
                    <SkillsSurface
                      client={conn.kind === "ready" ? conn.client : null}
                      workspace={selectedWs === "all" ? null : selectedWs}
                      focusedPaneName={activeId === null ? null : sessions.get(activeId)?.title ?? null}
                      canRunSkillInFocusedPane={canUseSkillInFocusedPane(
                        sessions,
                        activeId,
                        selectedWs,
                        conn.kind
                      )}
                      onRunSkill={runSkill}
                      tools={skills}
                      pushes={skillPushes}
                      autoPushEnabled={skillAutoPush}
                      onRefresh={() => {
                        if (conn.kind === "ready") conn.client.skillSync();
                      }}
                      onPush={(tool, skill) => {
                        if (conn.kind === "ready")
                          conn.client.skillPush(tool, skill);
                      }}
                      onPushUndo={(tool, skill) => {
                        if (conn.kind === "ready")
                          conn.client.skillPushUndo(tool, skill);
                      }}
                      onAutoPushSet={(enabled) => {
                        if (conn.kind === "ready")
                          conn.client.skillAutoPushSet(enabled);
                      }}
                      checkedAt={skillsCheckedAt}
                    />
                  ) : railView === "mcp" ? (
                    <McpSurface
                      {...mcpSurfaceLists(mcp)}
                      onRefresh={() => {
                        if (conn.kind === "ready") conn.client.mcpState();
                      }}
                      onSync={(tool) => {
                        if (conn.kind === "ready") conn.client.mcpSync(tool);
                      }}
                      onImport={(tool) => {
                        if (conn.kind === "ready") conn.client.mcpImport(tool);
                      }}
                      onSetEnabled={(name, enabled) => {
                        if (conn.kind === "ready")
                          conn.client.mcpSetEnabled(name, enabled);
                      }}
                      onUpsertServer={(previousName, server) => {
                        if (conn.kind === "ready") conn.client.mcpServerUpsert(previousName, server);
                      }}
                      onRemoveServer={(name) => {
                        if (conn.kind === "ready") conn.client.mcpServerRemove(name);
                      }}
                      onTest={(name) => {
                        if (conn.kind === "ready") conn.client.mcpTest(name);
                      }}
                      onOpenSource={() => {
                        if (mcp) void showItemInFolder(mcp.sourcePath);
                      }}
                      checkedAt={mcpCheckedAt}
                    />
                  ) : railView === "routines" ? (
                    <RoutinesSurface
                      routines={routines}
                      running={routinesRunning}
                      runs={routineRuns}
                      runsLoading={routineRunsLoading}
                      workspaces={workspaces.map((w) => ({
                        id: w.path,
                        name: w.name,
                      }))}
                      error={routineRefusal}
                      onDismissError={() => setRoutineRefusal(null)}
                      onCreate={(draft) => {
                        if (conn.kind === "ready") conn.client.routineCreate(draft);
                      }}
                      onUpdate={(mutation) => {
                        if (conn.kind !== "ready") return;
                        const { id, expected_revision, ...patch } = mutation;
                        conn.client.routineUpdate(id, expected_revision, patch);
                      }}
                      onDelete={(id, expectedRevision) => {
                        if (conn.kind === "ready")
                          conn.client.routineDelete(id, expectedRevision);
                      }}
                      onRunNow={(id) => {
                        if (conn.kind === "ready") conn.client.routineRunNow(id);
                      }}
                      onLoadRuns={(id) => {
                        if (conn.kind !== "ready") return;
                        lastRoutineRunsRequest.current = id;
                        setRoutineRunsLoading(id);
                        conn.client.routineRuns(id);
                      }}
                      onOpenSession={(sessionId) => {
                        setRailView(null);
                        focusPane(sessionId);
                      }}
                      onRequest={(request) => {
                        lastRoutineRequest.current = request;
                      }}
                      now={Date.now()}
                    />
                  ) : railView === "harness" ? (
                    <HarnessView
                      client={harness.client}
                      workspaces={workspaces.map((w) => ({
                        id: w.path,
                        name: w.name,
                      }))}
                      selectedWorkspace={selectedWs}
                      routinesRunning={routinesRunning}
                      onOpenFile={harness.openFile}
                      onReveal={harness.reveal}
                      attentionRows={harnessOverview}
                    />
                  ) : railView === "usage" ? (
                    <Suspense fallback={<div className="flex-1" />}>
                      <UsageSection
                        summary={usage}
                        activity={usageActivity}
                        loading={usageLoading}
                        error={usageError}
                        workspaces={workspaces.map((workspace) => ({ path: workspace.path, name: workspace.name }))}
                        initialWorkspace="all"
                        onRequest={requestUsage}
                        onActivityRequest={requestUsageActivity}
                      />
                    </Suspense>
                  ) : (
                  <Suspense fallback={<div className="flex-1" />}>
                    <SettingsView
                      daemonClient={scmProps.client}
                      chromeTheme={chromeTheme}
                      onChromeTheme={(theme, origin) =>
                        revealThemeFromClick(origin, () => setChromeTheme(theme))
                      }
                      theme={themeChoice}
                      onTheme={setTheme}
                      shellIntegration={shellIntegration}
                      onShellIntegration={setShellIntegration}
                      osc52={osc52}
                      onOsc52={setOsc52}
                      copyOnSelect={copyOnSelect}
                      onCopyOnSelect={setCopyOnSelect}
                      stripBoxGlyphs={stripBoxGlyphs}
                      onStripBoxGlyphs={setStripBoxGlyphs}
                      onOpenLogsFolder={() =>
                        void getLogsDir().then((dir) => showItemInFolder(dir))
                      }
                      onContact={() =>
                        void openExternal(
                          "https://github.com/theogmiguel/houston/issues/new",
                        )
                      }
                      fontSize={fontSize}
                      onFontSize={setFontSize}
                      fontMin={FONT_MIN}
                      fontMax={FONT_MAX}
                      fontDefault={FONT_DEFAULT}
                      fontFamilyId={fontFamilyId}
                      onFontFamilyId={setFontFamilyId}
                      terminalLineHeight={terminalLineHeight}
                      onTerminalLineHeight={setTerminalLineHeight}
                      terminalCursorBlink={terminalCursorBlink}
                      onTerminalCursorBlink={setTerminalCursorBlink}
                      terminalScrollbackLines={terminalScrollbackLines}
                      onTerminalScrollbackLines={setTerminalScrollbackLines}
                      shiftEnterNewline={shiftEnterNewline}
                      onShiftEnterNewline={setShiftEnterNewline}
                      openLinksInPane={openLinksInPane}
                      onOpenLinksInPane={setOpenLinksInPane}
                      uiZoom={uiZoom}
                      onUiZoom={setUiZoom}
                      zoomMin={ZOOM_MIN}
                      zoomMax={ZOOM_MAX}
                      zoomStep={ZOOM_STEP}
                      orchestrationState={orchestration}
                      onOpenAcpPane={(acpAgent) => {
                        if (conn.kind !== "ready" || selectedWs === "all")
                          return;
                        conn.client.createSession({
                          agent: acpAgent.agent,
                          project_dir: selectedWs,
                          acp: acpAgent.slug,
                          shell_integration: false,
                        });
                        setSettings(false);
                      }}
                      agentProfiles={agentProfiles}
                      onAgentProfileUpsert={(id, agent, name, configDir) => {
                        if (conn.kind === "ready")
                          conn.client.agentProfileUpsert(
                            id,
                            agent,
                            name,
                            configDir,
                          );
                      }}
                      onAgentProfileDelete={(id) => {
                        if (conn.kind === "ready")
                          conn.client.agentProfileDelete(id);
                      }}
                      onAgentProfileSetActive={(agent, id) => {
                        if (conn.kind === "ready")
                          conn.client.agentProfileSetActive(agent, id);
                      }}
                      voiceSettings={voiceSettings}
                      voiceCloudKeyPresent={voiceCloudKeyPresent}
                      voiceKeyringError={voiceKeyringError}
                      voiceModels={voiceModels}
                      voiceDevices={voiceDevices}
                      onVoiceSettingsSet={(next) => {
                        if (conn.kind !== "ready") return;
                        conn.client.voiceSettingsSet(next);
                      }}
                      onVoiceKeySet={(provider, key) => {
                        if (conn.kind !== "ready") return;
                        conn.client.voiceKeySet(provider, key);
                      }}
                      onVoiceKeyClear={(provider) => {
                        if (conn.kind !== "ready") return;
                        conn.client.voiceKeyClear(provider);
                      }}
                      onVoiceDevicesRefresh={() => {
                        if (conn.kind === "ready")
                          conn.client.voiceDevicesGet();
                      }}
                      onVoiceLevelMonitor={(enabled) => {
                        if (conn.kind !== "ready") return;
                        conn.client.voiceLevelMonitor(enabled);
                        if (!enabled) setVoiceLevel(null);
                      }}
                      historyWorkspace={
                        selectedWs === "all" ? null : selectedWs
                      }
                      historyWorkspaceName={wsName}
                      historyCount={historyCount}
                      onClearHistory={() => {
                        if (conn.kind !== "ready") return;
                        conn.client.historyClear();
                        conn.client.historyCount();
                      }}
                      keymapOverrides={keymapOverrides}
                      onKeymapOverrides={(next) => {
                        if (conn.kind !== "ready") return;
                        setKeymapOverrides(next);
                        conn.client.keymapSet(next);
                      }}
                      update={update}
                      onUpdateCheckNow={() => {
                        if (conn.kind === "ready") conn.client.updateCheckNow();
                      }}
                      onUpdatePolicySet={(policy) => {
                        if (conn.kind === "ready")
                          conn.client.updatePolicySet(policy);
                      }}
                      onOpenExternal={(url) => void openExternal(url)}
                      liveSessionCount={liveSessionCount(sessions.values())}
                      onOpenLicense={() =>
                        void openExternal(
                          "https://github.com/theogmiguel/houston/blob/main/NOTICE",
                        )
                      }
                      sessionPolicy={sessionPolicy}
                      onSessionPolicy={(next) => {
                        if (conn.kind === "ready")
                          conn.client.sessionPolicySet(next);
                      }}
                      hostInfo={hostInfo}
                      usage={usage}
                      usageLoading={usageLoading}
                      usageError={usageError}
                      onUsageRequest={requestUsage}
                      onRestoreBudgetSet={(n) => {
                        if (conn.kind === "ready")
                          conn.client.restoreBudgetSet(n);
                      }}
                      onRestoreResumeSet={(on) => {
                        if (conn.kind === "ready")
                          conn.client.restoreResumeSet(on);
                      }}
                      onWorktreeCleanupSet={(enabled, graceHours) => {
                        if (conn.kind === "ready")
                          conn.client.worktreeCleanupSet(enabled, graceHours);
                      }}
                      onMailboxRetentionSet={(hours) => {
                        if (conn.kind === "ready")
                          conn.client.mailboxRetentionSet(hours);
                      }}
                      onOrchestrationCapsSet={(
                        maxLiveChildren,
                        maxSpawnDepth,
                      ) => {
                        if (conn.kind === "ready") {
                          conn.client.orchestrationCapsSet(
                            maxLiveChildren,
                            maxSpawnDepth,
                          );
                        }
                      }}
                      onOpenHooks={() => {
                        setSettingsSection("agent-setup");
                        setSettings(true);
                      }}
                      agentHooks={agentHooks}
                      agentHooksCheckedAt={agentHooksCheckedAt}
                      onAgentHooksSet={(provider, enabled) => {
                        if (conn.kind === "ready") conn.client.agentHooksSet(provider, enabled);
                      }}
                      onAgentHooksRefresh={() => {
                        if (conn.kind === "ready") conn.client.agentHooks();
                      }}
                      orchestrationEnabled={orchestration?.enabled ?? false}
                      onOrchestrationEnabled={(v) => {
                        if (conn.kind !== "ready") return;
                        conn.client.orchestrationSet(v);
                      }}
                      historyIgnoreGlobs={historyIgnoreGlobs}
                      onHistoryIgnoreGlobsSet={(globs) => {
                        if (conn.kind === "ready")
                          conn.client.commandHistoryIgnoreGlobsSet(globs);
                      }}
                      onVoiceModelDownload={(modelId) => {
                        if (conn.kind === "ready")
                          conn.client.voiceModelDownload(modelId);
                      }}
                      onVoiceModelDelete={(modelId) => {
                        if (conn.kind === "ready")
                          conn.client.voiceModelDelete(modelId);
                      }}
                      onRevealSessionDb={() => {
                        if (hostInfo)
                          void openExternal(`file://${hostInfo.state_dir}`);
                      }}
                      desktopNotificationMode={desktopNotificationMode}
                      onDesktopNotificationMode={setDesktopNotificationMode}
                      inAppNotifications={inAppNotifications}
                      onInAppNotifications={setInAppNotifications}
                      desktopNotificationDelivery={desktopNotificationDelivery}
                    />
                  </Suspense>
                  )}
                </SurfaceBoundary>
              </div>
            ) : firstRunOpen || workspacesEmptyOpen ? (
              <div className="content-region absolute inset-0 flex z-[var(--z-leaf)]">
                {firstRunOpen ? (
                  <FirstRun
                    workspaces={{
                      keymapOverrides,
                      pending: pickingWorkspace,
                      refusals: workspaceRefusals,
                      error: addWorkspaceError,
                      onAdd: () => void addWorkspaceFromPicker(),
                    }}
                    hasWorkspace={workspaces.length > 0}
                    orchestrationConsented={firstRunOrchestrationConsented}
                    stateKnown={orchestration !== null && agentHooks !== null}
                    caps={orchestration?.caps ?? null}
                    onEnableOrchestration={() => {
                      if (conn.kind === "ready")
                        conn.client.orchestrationSet(true);
                    }}
                    hooksInstalled={firstRunHooksInstalled}
                    agentHooks={agentHooks}
                    onAgentHooksSet={(provider, enabled) => {
                      if (conn.kind === "ready") conn.client.agentHooksSet(provider, enabled);
                    }}
                    onDone={closeFirstRun}
                  />
                ) : (
                  <WorkspacesEmpty
                    keymapOverrides={keymapOverrides}
                    pending={pickingWorkspace}
                    refusals={workspaceRefusals}
                    error={addWorkspaceError}
                    onAdd={() => void addWorkspaceFromPicker()}
                  />
                )}
              </div>
            ) : null}
          </main>

          {chromeMigrationNotice && !chromeMigrationNoticeDismissed && (
            <div
              data-testid="chrome-theme-migration-notice"
              role="status"
              className="absolute top-3 left-1/2 -translate-x-1/2 z-[var(--z-overlay)] flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--card-bg)] shadow-[var(--shadow-md)] px-3.5 py-2 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] max-w-[560px]"
            >
              <span>
                Chrome themes went from 24 to 3. Your{" "}
                <strong className="text-[var(--text-primary)]">
                  {THEME_LABELS[chromeMigrationNotice]}
                </strong>{" "}
                pick became{" "}
                <strong className="text-[var(--text-primary)]">
                  {CHROME_THEME_LABELS[chromeTheme]}
                </strong>{" "}
                chrome — your terminal palette didn&apos;t change. Pick a
                different chrome theme any time in Settings → Appearance.
              </span>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setChromeMigrationNoticeDismissed(true)}
                className="border-0 bg-transparent flex-none rounded-[var(--tr-radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]"
              >
                <Icon glyph={IconClose} role="small" />
              </button>
            </div>
          )}

          {addPanePopover && (
            <AddPanePopover
              right={addPanePopover.right}
              y={addPanePopover.y}
              hasWorkspace={selectedWs !== "all"}
              keymapOverrides={keymapOverrides}
              onClose={() => setAddPanePopover(null)}
              onNewTerminal={newTerminal}
              onSpawnAgent={spawnAgentPane}
              agentProfiles={agentProfiles}
              workspaceActions={workspaceActions}
              onRunWorkspaceAction={workspaceActionState.run}
              onSaveWorkspaceAction={workspaceActionState.save}
              onDeleteWorkspaceAction={workspaceActionState.remove}
              onSplitDown={
                typeof addPanePopover.anchor === "number"
                  ? () =>
                      handleSplitFromLayout(
                        addPanePopover.anchor as number,
                        "bottom",
                      )
                  : undefined
              }
              onNewGrid={() => handleAddGrid(selectedWs)}
            />
          )}

          <PrefixHint />

          <AnimOut open={shortcutSheet} suppress="modal">
            <ShortcutSheet onClose={() => setShortcutSheet(false)} />
          </AnimOut>

          <AnimOut open={paletteOpen} suppress="modal">
            {paletteOpen && (
              <Suspense fallback={null}>
                <CommandPalette
                  onClose={() => setPaletteOpen(false)}
                  actions={paletteActions}
                  hasWorkspace={selectedWs !== "all"}
                  workspaces={orderedWorkspaces}
                  grids={paletteGrids}
                  sessions={[...sessions.values()]}
                  activeSessionId={activeId}
                  appearance={{
                    currentTheme: theme,
                    onPreview: setTheme,
                    onCommit: setTheme,
                  }}
                />
              </Suspense>
            )}
          </AnimOut>

          <AnimOut open={confirmRemoveWs !== null} suppress="modal">
            {confirmRemoveWs && (
              <ConfirmModal
                message={confirmRemoveWs.message}
                confirmLabel={confirmRemoveWs.confirmLabel}
                onConfirm={confirmRemoveWorkspace}
                onCancel={() => setConfirmRemoveWs(null)}
              />
            )}
          </AnimOut>

          <QuitAndStopDaemonConfirm
            confirm={quitAndStopDaemonConfirm}
            onConfirm={confirmQuitAndStopDaemon}
            onCancel={() => setQuitAndStopDaemonConfirm(null)}
          />

          <AnimOut open={liveChildrenConfirm !== null} suppress="modal">
            {liveChildrenConfirm && (
              <ConfirmModal
                title="Pane has live children"
                message={liveChildrenConfirm.message}
                confirmLabel="Kill anyway"
                onConfirm={() => {
                  if (conn.kind !== "ready") {
                    setLiveChildrenConfirm(null);
                    return;
                  }
                  if (liveChildrenConfirm.kind === "kill") {
                    conn.client.confirmKillSession(liveChildrenConfirm.session);
                  } else {
                    conn.client.confirmCloseSession(
                      liveChildrenConfirm.session,
                    );
                  }
                  setLiveChildrenConfirm(null);
                }}
                onCancel={() => setLiveChildrenConfirm(null)}
              />
            )}
          </AnimOut>

          <AnimOut open={paneHandoff !== null} suppress="modal">
            {paneHandoff && (
              <Suspense fallback={null}>
                <PaneHandoff
                  source={paneHandoff}
                  onCancel={() => setPaneHandoff(null)}
                  onHandoff={runPaneHandoff}
                />
              </Suspense>
            )}
          </AnimOut>

          <AnimOut open={sshModal} suppress="modal">
            <Suspense fallback={null}>
              <SshConnectModal
                profiles={sshProfiles}
                initial={sshPrefill}
                onConnect={sshConnect}
                onSaveProfile={sshSaveProfile}
                onSetCredential={sshSetCredential}
                onClearCredential={sshClearCredential}
                configHosts={sshConfigHosts}
                keyringError={sshKeyringError}
                onLoadConfigHosts={sshLoadConfigHosts}
                onDeleteProfile={sshDeleteProfile}
                onClose={() => setSshModal(false)}
              />
            </Suspense>
          </AnimOut>

          <AnimOut open={hostKeyPrompt !== null} suppress="modal">
            <HostKeyModalHost
              queue={hostKeyQueue}
              onAnswer={answerHostKey}
              onRejectRemaining={rejectRemainingHostKeys}
            />
          </AnimOut>

          <UpdateInstallHost
            update={update}
            sessions={[...sessions.values()]}
            onOpenExternal={(url) => void openExternal(url)}
          />

          {pendingAct && !pendingAct.hasScreenshot && (
            <BrowserActConfirmModal
              request={pendingAct}
              onDone={() => {
              }}
            />
          )}

        </Shell>
      </TagsContext.Provider>
      </KeymapOverridesContext.Provider>
    </TerminalTuningContext.Provider>
    </SessionsStoreContext.Provider>
  );
}
