import { SettingsFooterItem } from './ui/SettingsFooterItem'
import type { AgentAttention } from '../useAgentAttention'
import { MascotMount } from '../mascot/MascotMount'
import type { TagInfo } from "../houston/generated/TagInfo";
import {
  Suspense,
  lazy,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { HoustonClient, SessionInfo, Workspace } from "../houston/client";
import type { ChromeTheme } from "../theme";
import {
  setSettingsOpen,
  useSettingsOpen,
  useSettingsSection,
} from "../settingsNav";
import { useCustomSurface } from "./customChrome";
import {
  NAVIGABLE_SETTINGS_SECTIONS,
} from "../settingsSections";
import { translateFilteredDropIndex } from "../layout/wsOrder";
import { KeymapOverridesContext } from "../layout/keymapOverridesContext";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconFolder,
  IconFolderPlus,
  IconGitPullRequest,
  IconGrid,
  IconMoon,
  IconPanelLeft,
  IconPin,
  IconPlus,
  IconSun,
  IconSliders,
  IconServer,
  IconTux,
  IconTasks,
  IconChartArea,
  IconClock,
  type IconProps,
} from "./icons";
import { Tooltip } from "./ui/Tooltip";
import { gridAgentCount, useGridCloseConfirm } from "./rail/LastGridConfirm";
import { NavigationRailHeader } from "./ui/NavigationRail";
import logoUrl from "../assets/brand-mark";
import { Icon } from "./ui/Icon";
import { Count } from "./ui/Count";
import { wslWorkspaces } from "../houston/environments";
import {
  RAIL_VIEWS,
  RAIL_VIEW_LABEL,
  toggleRailView,
  useHiddenRailViews,
  useRailView,
  type RailView,
} from "../railView";
import { Button } from "./ui/Button";
import { NavigationRailFooter, NavigationRailScroll } from "./ui/NavigationRailFooter";
import {
  NavigationRail,
  NavigationRailSection,
  NavigationRailItem,
  NavigationRailSearch,
  RailSurface,
} from "./ui/NavigationRail";
import { openUpdateModal } from "../updateModal";
import { isUpdateInstallRunning, useUpdateInstall } from "../updateInstall";
import { useRailGitCache } from "./git/railGitCache";
import { useRailPrCache } from "./git/railPrCache";
import type { RailDiffTotals } from "./git/useRailGitFacts";
import type { RailPrState } from "./git/railPrCache";
import { GridRailRowFallback, preloadGridRailRow } from "./ui/GridRailRowFallback";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuItems,
} from "./ui/ContextMenu";
import {
  WorkspaceTreeRow,
  WorkspaceTreeLabel,
  WorkspaceTreeActions,
  WorkspaceTreeAuxButton,
  WorkspaceDropIndicator,
  EmptyListMessage,
} from "./ui/WorkspaceTreeRow";
import { TextInput } from "./ui/TextInput";
import {
  canReorderRailGrid,
  GRID_PINNED_KEY,
  GRID_PINNED_MIGRATION_KEY,
  isRailGridUnread,
  isStaleGridKey,
  loadPinnedGridIds,
  loadRailPrefs,
  migratePinnedWorkspaces,
  migrateRailGridKeys,
  moveSelectedRailGrid,
  pruneRailGridState,
  railUnreadSignature,
  reorderRailGrid,
  saveRailPrefs,
  type RailPrefs,
} from "../railPrefs";
import { gridStorageKey } from "../layout/tree";
import { TagPopoverHost, useTagPopover, type TagGrid } from "./tags/TagPopover";

/** Window event that opens tag management anchored to the rail Options button. */
export const MANAGE_TAGS_EVENT = "houston:open-manage-tags";
import { buildRailCard, RAIL_DRAG_REFUSAL, type RailCard } from "./rail/railCardModel";
import { RailList, type RailListItem } from "./rail/RailList";
import {
  buildRailEntries,
  countGridChildren,
  entryKey,
  hiddenByTagFilter,
  layoutRailTree,
  neighbourGridId,
  railEmptyMessage,
  selectedCardItemKey,
  visibleDropSlot,
  type GridItem,
  type RailEntry,
  type RailTreeModel,
} from "./rail/railTreeModel";
import { useSettledSmartCards } from "./rail/useSettledSmartCards";
import { useAltDigitJump } from "./rail/useAltDigitJump";
import { useMenuDismiss } from "./rail/useMenuDismiss";
import { useEdgeAutoScroll, workspaceDropIndex } from "./rail/railAutoScroll";
import {
  RailChevron,
  RailFilterCountBadge,
  RailGridRenameFrame,
  RailActiveTagFilter,
  RailGroupCount,
  RailGroupHeader,
  RailGroupStatusDot,
  RailGroupToggle,
  RailPinnedIndicator,
  RailRowCount,
  RailSrOnlyText,
  RailTreeGroupHeader,
  RailTreeTitle,
  RailUpdateDot,
  RailUpdateIconButton,
  RailWorkspaceGroupRow,
} from "./ui/rail/RailChrome";
import { preloadable } from "../preloadable";
import type { CtxMenu, GridCtxMenu } from "./rail/RailContextMenus";
import { useRailUndoActions } from "./rail/useRailUndoActions";
import type { NoticeStore } from "../notices";

const GridRailGitSubscription = lazy(() =>
  import("./git/GridRailGitSubscription").then((module) => ({ default: module.GridRailGitSubscription })),
);
const LazyGridRailRow = lazy(() => import("./ui/GridRailRow").then((module) => ({ default: module.GridRailRow })));
const railOptionsMenu = preloadable(() => import("./rail/RailOptionsMenu").then((module) => module.RailOptionsMenu));
const RailOptionsMenu = railOptionsMenu.Slot;

const railSettingsTree = preloadable(() => import("./rail/RailSettingsTree").then((module) => module.SettingsTree));
const SettingsTree = railSettingsTree.Slot;

const railContextMenus = {
  workspace: preloadable(() => import("./rail/RailContextMenus").then((module) => module.WorkspaceContextMenu)),
  grid: preloadable(() => import("./rail/RailContextMenus").then((module) => module.GridContextMenu)),
  nav: preloadable(() => import("./rail/RailContextMenus").then((module) => module.NavViewMenu)),
};
const WorkspaceContextMenu = railContextMenus.workspace.Slot;
const GridContextMenu = railContextMenus.grid.Slot;
const NavViewMenu = railContextMenus.nav.Slot;
/** Loads the rail's code-split menus and settings tree; the rail calls it on idle after mount, tests in `beforeAll`. */
export const preloadRailChunks = (): Promise<unknown> =>
  Promise.all([railOptionsMenu.preload(), railSettingsTree.preload(), ...Object.values(railContextMenus).map((menu) => menu.preload())]);

function RailOptionsMenuHost({ anchor, prefs, onChange, onClose, selectedTagIds, selectedTagColors, onClearTagFilter }: {
  anchor: HTMLElement | null;
  prefs: RailPrefs;
  onChange: (next: RailPrefs) => void;
  onClose: () => void;
  selectedTagIds: number[];
  selectedTagColors: string[];
  onClearTagFilter: () => void;
}): React.JSX.Element | null {
  if (!anchor) return null;
  return <RailOptionsMenu anchor={anchor} prefs={prefs} onChange={onChange} onClose={onClose} selectedTagIds={selectedTagIds} selectedTagColors={selectedTagColors} onClearTagFilter={onClearTagFilter} />;
}

// Lives under TagPopoverHost so Escape can close the popover through its host API.
function RailMenuDismiss({ open, onCloseAll }: { open: boolean; onCloseAll: () => void }): null {
  useMenuDismiss(open, onCloseAll, useTagPopover().close);
  return null;
}

function WorkspaceRailGroupRow({
  workspace,
  count,
  hasGrids,
  index,
  color,
  collapsed,
  selected,
  highlighted,
  pinned,
  dragging,
  dragged,
  renaming,
  dragActiveRef,
  startWsDrag,
  onSelect,
  onToggle,
  onOpenMenu,
  onNewSession,
  onRenameSubmit,
  onRenameCancel,
}: {
  workspace: Workspace;
  count: number;
  hasGrids: boolean;
  index: number;
  color: string;
  collapsed: boolean;
  selected: boolean;
  /** Fills the row: the selection has no card of its own to show here. */
  highlighted: boolean;
  pinned: boolean;
  dragging: boolean;
  dragged: boolean;
  renaming: boolean;
  dragActiveRef: React.RefObject<boolean>;
  startWsDrag: (event: React.PointerEvent, path: string) => void;
  /** Selects the workspace and expands it when collapsed. */
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onOpenMenu: (event: React.MouseEvent, workspace: Workspace, color: string) => void;
  onNewSession?: (path: string) => void;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
}): React.JSX.Element {
  if (renaming) {
    return <WorkspaceRenameField w={workspace} i={index} color={color} onRenameSubmit={onRenameSubmit} onRenameCancel={onRenameCancel} />;
  }
  return (
    <Tooltip label={workspace.path}>
      <RailWorkspaceGroupRow
        kind="tree"
        selected={highlighted}
        dragging={dragging}
        dragged={dragged}
        role="button"
        tabIndex={0}
        aria-label={workspace.path}
        aria-current={selected ? 'true' : undefined}
        aria-expanded={hasGrids ? !collapsed : undefined}
        data-testid={hasGrids ? 'ws-disclosure' : undefined}
        data-ws-idx={index}
        data-dragging={dragged || undefined}
        onPointerDown={(event) => {
          dragActiveRef.current = false;
          if (event.button === 0) startWsDrag(event, workspace.path);
        }}
        onClick={() => {
          if (dragActiveRef.current) {
            dragActiveRef.current = false;
            return;
          }
          onSelect(workspace.path);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(workspace.path);
          } else if (hasGrids && ((event.key === 'ArrowRight' && collapsed) || (event.key === 'ArrowLeft' && !collapsed))) {
            event.preventDefault();
            onToggle(workspace.path);
          }
        }}
        onContextMenu={(event) => onOpenMenu(event, workspace, color)}
      >
        {hasGrids && (
          <Button
            type="button"
            variant="disclosure-icon"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${workspace.name}`}
            data-testid="ws-chevron"
            className="flex-none"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(workspace.path);
            }}
          >
            <RailChevron collapsed={collapsed} />
          </Button>
        )}
        {!hasGrids && <span aria-hidden="true" className="flex-none"><RailChevron collapsed /></span>}
        <Icon glyph={IconFolder} role="ui" opacity="muted" />
        <WorkspaceTreeLabel heading>{workspace.name}</WorkspaceTreeLabel>
        {count > 0 && <RailRowCount count={count} />}
        <EnvironmentBadge path={workspace.path} />
        {pinned && <PinIndicator />}
        <WorkspaceTreeActions>
          {onNewSession && (
            <Tooltip label="New session">
              <WorkspaceTreeAuxButton
                aria-label={`New session in ${workspace.name}`}
                data-testid="ws-new-session"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onNewSession(workspace.path); }}
              >
                <Icon glyph={IconPlus} role="small" />
              </WorkspaceTreeAuxButton>
            </Tooltip>
          )}
        </WorkspaceTreeActions>
      </RailWorkspaceGroupRow>
    </Tooltip>
  );
}

function ThemeToggle({ chromeTheme, onToggle }: { chromeTheme: ChromeTheme; onToggle: (origin: HTMLElement) => void }): React.JSX.Element {
  const paper = chromeTheme === "paper";
  const label = paper ? "Switch to dark theme" : "Switch to light theme";
  return (
    <Tooltip label={label}>
      <Button variant="subtle-icon" aria-label={label} onClick={(event) => onToggle(event.currentTarget)}>
        <Icon glyph={paper ? IconSun : IconMoon} role="ui" />
      </Button>
    </Tooltip>
  );
}

// Its own component so the foot keeps no branch of its own: nothing at all is
// rendered until a release is waiting or an install is running or has failed.
function RailUpdateButton({ version }: { version?: string | null }): React.JSX.Element | null {
  const install = useUpdateInstall();
  const running = isUpdateInstallRunning(install);
  const failed = install.kind === "failed";
  if (version == null && !running && !failed) return null;
  const content = failed
    ? "Update failed"
    : install.kind === "downloading"
      ? install.total && install.total > 0
        ? `Updating ${Math.floor((install.downloaded / install.total) * 100)}%`
        : "Updating…"
      : running
        ? "Updating…"
        : `${version} available`;
  const label = failed
    ? `Houston ${install.version} did not install. Open to see why and try again`
    : running
      ? "Houston is installing an update. Open to see the steps"
      : `Houston v${version} is available. Open to install`;
  return (
    <Tooltip label={label}>
      <RailUpdateIconButton
        variant="subtle-icon"
        failed={failed}
        data-testid="rail-update-available"
        aria-label={label}
        onClick={openUpdateModal}
      >
        <Icon glyph={failed ? IconAlertTriangle : IconArrowDown} role="ui" />
        {!failed && !running && <RailUpdateDot />}
        <RailSrOnlyText>{content}</RailSrOnlyText>
      </RailUpdateIconButton>
    </Tooltip>
  );
}

const WS_COLLAPSED_KEY = "tr-ws-collapsed";

export function loadCollapsedWorkspaces(): Set<string> {
  try {
    const raw = localStorage.getItem(WS_COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsedWorkspaces(paths: Set<string>): void {
  try {
    localStorage.setItem(WS_COLLAPSED_KEY, JSON.stringify([...paths]));
  } catch {
  }
}

export const WS_COLORS = [
  "#94a3b8",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f43f5e",
];

export function workspaceColor(index: number): string {
  return WS_COLORS[index % WS_COLORS.length];
}

interface Props {
  mascotFirstRun?: boolean;
  mascotWorkspacesEmpty?: boolean;
  workspaces: Workspace[];
  sessions: SessionInfo[];
  /** Top-level panes that finished while no grid showed them; shown through the unread dot. */
  finishedUnseen?: ReadonlySet<number>;
  selected: string;
  customColors: Record<string, string>;
  colorIndexByPath: Record<string, number>;
  renaming: string | null;
  onSelect: (key: string) => void;
  onAddWorkspace: () => void;
  onRemoveWorkspace: (path: string) => void;
  onRenameStart: (path: string) => void;
  onLocateStart?: (path: string) => void;
  onOpenExternalError?: (message: string) => void;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  onChangeColor: (path: string, color: string) => void;
  onReorderWorkspace: (fromPath: string, toIndex: number) => void;
  pinnedWorkspaces: ReadonlySet<string>;
  onTogglePinWorkspace: (path: string) => void;
  /** Where reversible rail actions offer Undo. */
  notices?: Pick<NoticeStore, "push" | "dismiss">;
  onSshConnect: () => void;
  railClient?: HoustonClient | null;
  checkoutBranches?: ReadonlyMap<number, string>;
  onOpenInspector?: (paneId: number, tab: "changes" | "pull-request") => void;

  gridsByWorkspace?: Record<string, GridItem[]>;
  tags?: TagInfo[];
  onSetGridTags?: (path: string, gridId: string, tagIds: number[]) => void;
  onTagCreate?: (name: string, color: string) => void;
  onTagUpdate?: (tag: number, name: string, color: string) => void;
  onTagDelete?: (tag: number) => void;
  onSelectGrid?: (path: string, gridId: string) => void;
  onFocusPane?: (paneId: number) => void;
  selectedGridId?: string | null;

  onAddGrid?: (path: string) => void;
  onNewWorkspaceSession?: (path: string) => void;
  onRenameGrid?: (path: string, gridId: string, name: string) => void;
  /** Hands a user-named grid back to automatic naming. */
  onResetGridName?: (path: string, gridId: string) => void;
  /** `nextGridId` is the neighbour to select when the closed grid was the selected one. */
  onRemoveGrid?: (path: string, gridId: string, nextGridId?: string) => void;

  onOpenSettings?: () => void;
  onOpenPullRequests?: () => void;
  currentRailView?: RailView;
  onOpenPalette?: () => void;
  paletteChord?: string | null;
  onHideRail?: () => void;
  chromeTheme: ChromeTheme;
  onToggleChromeTheme: (origin: HTMLElement) => void;
  updateVersion?: string | null;
  harnessAttention?: number;
  agentAttention?: AgentAttention;
  taskTurnCount?: number;
  /** Parked merge queue entries; the Pull requests row counts them in accent. */
  mergeQueueParked?: number;

  className?: string;
  gridArea?: 'rail';
  onHeadMouseDown?: (e: React.MouseEvent) => void;
  onHeadDoubleClick?: (e: React.MouseEvent) => void;
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    ref.current?.select();
  }, []);

  return (
    <TextInput
      ref={ref}
      variant="inline-edit"
      defaultValue={initial}
      autoFocus
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          ref.current?.blur();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!cancelled.current) onSubmit(ref.current?.value ?? initial);
      }}
    />
  );
}

// Reads the facts off the card the row shows, so the menu acts on the same pane and checkout.
function railGridContextFacts(
  card: RailCard,
  workspacePath: string,
): Pick<GridCtxMenu, "paneId" | "branch" | "checkoutPath" | "worktreePath" | "pr" | "gh"> {
  const identity = card.checkouts[0];
  const root = identity && "root" in identity ? identity.root : null;
  return {
    paneId: card.agents[0]?.session.id ?? null,
    branch: identity && (identity.kind === "primary" || identity.kind === "worktree") ? identity.branch : null,
    checkoutPath: root ?? workspacePath,
    worktreePath: identity?.kind === "worktree" ? identity.root : null,
    pr: card.pr?.pr ?? null,
    gh: card.pr?.gh ?? null,
  };
}

function portalOrNull(el: React.ReactElement | null): React.ReactPortal | null {
  return el && createPortal(el, document.body);
}

function allGridKeys(gridsByWorkspace: Record<string, { id: string }[]>): string[] {
  return Object.entries(gridsByWorkspace).flatMap(([path, grids]) => grids.map((grid) => gridStorageKey(path, grid.id)));
}

const TAG_FILTER_KEY = "houston.tagFilter";

function loadTagFilter(): number[] {
  try {
    const raw = localStorage.getItem(TAG_FILTER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === "number");
  } catch {
    return [];
  }
}

function tagsOf(s: SessionInfo): number[] {
  return s.tags ?? [];
}

// A workspace that lives in a WSL distro shows Tux, naming the distro on hover and to
// screen readers; Windows workspaces show nothing.
function EnvironmentBadge({ path }: { path: string }): React.JSX.Element | null {
  const distro = wslWorkspaces.get(path);
  if (distro === undefined) return null;
  const label = `WSL: ${distro}`;
  return (
    <Tooltip label={label} inline>
      <Icon glyph={IconTux} role="ui" opacity="muted" label={label} />
    </Tooltip>
  );
}

function PinIndicator(): React.JSX.Element {
  return <RailPinnedIndicator />;
}

function workspaceCarriesTag(
  path: string,
  grids: GridItem[] | undefined,
  sessions: SessionInfo[],
  activeTagIds: number[],
): boolean {
  if (activeTagIds.length === 0) return true;
  if (grids && grids.length > 0)
    return grids.some((g) => !hiddenByTagFilter(g, activeTagIds));
  return sessions.some(
    (s) =>
      s.project_dir === path &&
      tagsOf(s).some((id) => activeTagIds.includes(id)),
  );
}

function WorkspaceRenameField({
  w,
  i,
  color,
  onRenameSubmit,
  onRenameCancel,
}: {
  w: Workspace;
  i: number;
  color: string;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
}): React.JSX.Element {
  return (
    <WorkspaceTreeRow
      data-ws-idx={i}
      data-testid="ws-row-renaming"
      kind="editing"
      selectionColor={color}
    >
      <RenameInput
        initial={w.name}
        onSubmit={(name) => onRenameSubmit(w.path, name)}
        onCancel={onRenameCancel}
      />
    </WorkspaceTreeRow>
  );
}

function RailHead({
  onHeadMouseDown,
  onHeadDoubleClick,
  onHideRail,
}: {
  onHeadMouseDown?: (e: React.MouseEvent) => void;
  onHeadDoubleClick?: (e: React.MouseEvent) => void;
  onHideRail?: () => void;
}): React.JSX.Element {
  return (
    <NavigationRailHeader
      logo={logoUrl}
      onMouseDown={onHeadMouseDown}
      onDoubleClick={onHeadDoubleClick}
      action={onHideRail && (
        <Tooltip label="Hide sidebar (Ctrl+B)">
          <Button
            variant="subtle-icon"
            aria-label="Hide sidebar"
            noDrag
            onClick={onHideRail}
          >
            <Icon glyph={IconPanelLeft} role="ui" />
          </Button>
        </Tooltip>
      )}
    >
      Houston
    </NavigationRailHeader>
  );
}

const RAIL_VIEW_ICON: Readonly<Record<RailView, (p: IconProps) => React.JSX.Element>> =
  Object.freeze({
    tasks: IconTasks,
    routines: IconClock,
    prs: IconGitPullRequest,
    usage: IconChartArea,
  });

/** A rail row's count: the task turns in warn ink, parked merge queue entries in accent. */
function railCount(view: RailView, taskTurnCount: number, mergeQueueParked = 0): React.JSX.Element | null {
  if (view === "tasks" && taskTurnCount > 0) return <Count value={taskTurnCount} from="warn" />;
  if (view === "prs" && mergeQueueParked > 0) return <Count value={mergeQueueParked} from="accent" />;
  return null;
}

function RailNav({
  view,
  hidden,
  paletteChord,
  taskTurnCount,
  mergeQueueParked,
  onOpenPalette,
  onSelect,
  onRowMenu,
}: {
  view: RailView | null;
  hidden: ReadonlySet<RailView>;
  paletteChord: string | null | undefined;
  taskTurnCount: number;
  mergeQueueParked: number | undefined;
  onOpenPalette: (() => void) | undefined;
  onSelect: (v: RailView) => void;
  onRowMenu: (e: React.MouseEvent, v: RailView) => void;
}): React.JSX.Element {
  const shown = RAIL_VIEWS.filter((v) => !hidden.has(v));
  return (
    <NavigationRail>
      <Tooltip label={paletteChord ? `Search (${paletteChord})` : "Search"}>
        <NavigationRailSearch paletteChord={paletteChord} onClick={onOpenPalette} />
      </Tooltip>
      {shown.map((v) => {
        const on = view === v;
        return (
          <NavigationRailItem
            key={v}
            data-testid="rail-nav-row"
            data-view={v}
            icon={RAIL_VIEW_ICON[v]}
            label={RAIL_VIEW_LABEL[v]}
            selected={on}
            onClick={() => onSelect(v)}
            onContextMenu={(e) => onRowMenu(e, v)}
            trailing={railCount(v, taskTurnCount, mergeQueueParked)}
          />
        );
      })}
    </NavigationRail>
  );
}

function AddWorkspaceMenu({ onAddWorkspace, onSshConnect }: {
  onAddWorkspace: () => void;
  onSshConnect: () => void;
}): React.JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    const close = (): void => setPosition(null);
    const onDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.stopPropagation(); close(); trigger.current?.focus(); }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [position]);
  const dispatch = (action: () => void): void => { setPosition(null); trigger.current?.focus(); action(); };
  return <>
    <Tooltip label="Add workspace">
      <Button
        ref={trigger}
        variant="compact-icon-secondary"
        aria-label="Add workspace"
        aria-haspopup="menu"
        aria-expanded={position !== null}
        onClick={() => {
          const rect = trigger.current!.getBoundingClientRect();
          setPosition(position ? null : {
            x: Math.max(8, Math.min(rect.right - 244, window.innerWidth - 252)),
            y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 88)),
          });
        }}><Icon glyph={IconFolderPlus} role="ui" /></Button>
    </Tooltip>
    {position && portalOrNull(
      <ContextMenu
        ref={menuRef}
        role="menu"
        aria-label="Add workspace"
        className=""
        style={{ left: position.x, top: position.y }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) {
            setPosition(null)
          }
        }}
      >
        <ContextMenuItems>
          <ContextMenuItem type="button" role="menuitem" onClick={() => dispatch(onAddWorkspace)}>
            <Icon glyph={IconFolder} role="ui" />
            <span>Local folder…</span>
          </ContextMenuItem>
          <ContextMenuItem type="button" role="menuitem" data-testid="rail-ssh-connect" onClick={() => dispatch(onSshConnect)}>
            <Icon glyph={IconServer} role="ui" />
            <span>Connect via SSH…</span>
          </ContextMenuItem>
        </ContextMenuItems>
      </ContextMenu>,
    )}
  </>;
}

function RailTreeHeader({
  treeLabel, activeFilterCount, railOptionsAnchor, setRailOptionsAnchor, triggerRef, onAddWorkspace, onSshConnect,
  onAddGrid, railPrefs, onRailPrefsChange, activeTagIds, tagById, onClearTagFilter,
}: {
  treeLabel: string;
  activeFilterCount: number;
  railOptionsAnchor: HTMLElement | null;
  setRailOptionsAnchor: (anchor: HTMLElement | null) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onAddWorkspace: () => void;
  onSshConnect: () => void;
  /** Absent when a grid cannot be added: no workspace is selected. */
  onAddGrid?: () => void;
  railPrefs: RailPrefs;
  onRailPrefsChange: (prefs: RailPrefs) => void;
  activeTagIds: number[];
  tagById: ReadonlyMap<number, TagInfo>;
  onClearTagFilter: () => void;
}): React.JSX.Element {
  return (
    <RailTreeGroupHeader>
      <RailTreeTitle>{treeLabel}</RailTreeTitle>
      <Tooltip label="Sidebar options">
        <Button
          type="button"
          variant="compact-icon"
          aria-label="Sidebar options"
          aria-expanded={railOptionsAnchor !== null}
          data-testid="tree-filter-toggle"
          data-options-testid="rail-options-trigger"
          ref={triggerRef}
          onClick={(event) => setRailOptionsAnchor(railOptionsAnchor ? null : event.currentTarget)}
          className="relative"
        >
          <Icon glyph={IconSliders} role="ui" />
          {activeFilterCount > 0 && (
            <RailFilterCountBadge>
              {activeFilterCount > 9 ? '9+' : activeFilterCount}
            </RailFilterCountBadge>
          )}
        </Button>
      </Tooltip>
      <AddWorkspaceMenu onAddWorkspace={onAddWorkspace} onSshConnect={onSshConnect} />
      <Tooltip label={onAddGrid ? "New grid" : "Select a workspace to add a grid"}>
        <Button type="button" variant="compact-icon" aria-label="New grid" disabled={!onAddGrid} onClick={onAddGrid}>
          <Icon glyph={IconPlus} role="ui" />
        </Button>
      </Tooltip>
      <RailOptionsMenuHost
        anchor={railOptionsAnchor}
        prefs={railPrefs}
        onChange={onRailPrefsChange}
        onClose={() => setRailOptionsAnchor(null)}
        selectedTagIds={activeTagIds}
        selectedTagColors={activeTagIds.flatMap((id) => tagById.get(id)?.color ?? [])}
        onClearTagFilter={onClearTagFilter}
      />
    </RailTreeGroupHeader>
  );
}

function RailLabelGroupHeader({ label, kind, groupBy, count, collapsed, onToggle }: {
  label: string;
  kind: "pinned" | "label";
  groupBy: RailPrefs["groupBy"];
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <RailGroupHeader>
      <RailGroupToggle aria-expanded={!collapsed} onClick={onToggle}>
        {kind === 'pinned' ? <Icon glyph={IconPin} role="small" tone="faint" className="flex-none" />
          : groupBy === 'status' ? <RailGroupStatusDot label={label} />
            : <Icon glyph={IconGitPullRequest} role="small" tone="faint" className="flex-none" />}
        <span className="truncate">{label}</span>
        {count > 0 && <RailGroupCount>{count}</RailGroupCount>}
      </RailGroupToggle>
    </RailGroupHeader>
  );
}

function GridRenameRow({ cardMode, selected, initial, onSubmit, onCancel }: {
  cardMode: "detailed" | "compact";
  selected: boolean;
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <RailGridRenameFrame cardMode={cardMode} selected={selected}>
      <Icon glyph={IconGrid} role="ui" opacity="muted" />
      <RenameInput initial={initial} onSubmit={onSubmit} onCancel={onCancel} />
    </RailGridRenameFrame>
  );
}

function RailTree({
  treeLabel,
  activeFilterCount,
  onSshConnect,
  onAddWorkspace,
  selected,
  canAddGrid,
  model,
  workspaces,
  pinnedWorkspaces,
  sessions,
  colorOf,
  activeTagIds,
  tagById,
  dragPath,
  wsDropIndex,
  dragActiveRef,
  startWsDrag,
  onSelectWorkspace,
  toggleWsOpen,
  openMenu,
  onNewWorkspaceSession,
  selectedGridId,
  gridRenaming,
  onRenameGrid,
  onRemoveGrid,
  onSelectGrid,
  onFocusPane,
  openGridMenu,
  gridMenuOpen,
  setGridRenaming,
  renaming,
  onRenameSubmit,
  onRenameCancel,
  onOpenInspector,
  checkoutBranches,
  railDiffByDir,
  railPrByDir,
  railPrefs,
  pinnedGridIds,
  onRailPrefsChange,
  onFilterTag,
  onClearTagFilter,
  railOptionsAnchor,
  setRailOptionsAnchor,
  onAddGrid,
  suppressGridClickRef,
  onGridPointerDown,
  gridDragId,
  gridDrop,
  gridDragRefused,
  hoverSuppressed,
  scrollRef,
  onToggleGridUnread,
  isGridUnread,
}: {
  treeLabel: string;
  activeFilterCount: number;
  onSshConnect: () => void;
  onAddWorkspace: () => void;
  selected: string;
  canAddGrid: boolean;
  model: RailTreeModel;
  workspaces: Workspace[];
  pinnedWorkspaces: ReadonlySet<string>;
  sessions: SessionInfo[];
  colorOf: (path: string) => string;
  activeTagIds: number[];
  tagById: ReadonlyMap<number, TagInfo>;
  dragPath: string | null;
  wsDropIndex: number | null;
  dragActiveRef: React.RefObject<boolean>;
  startWsDrag: (e: React.PointerEvent, path: string) => void;
  onSelectWorkspace: (path: string) => void;
  toggleWsOpen: (path: string) => void;
  openMenu: (e: React.MouseEvent, w: Workspace, color: string) => void;
  onNewWorkspaceSession?: (path: string) => void;
  selectedGridId: string | null;
  gridRenaming: { path: string; gridId: string } | null;
  onRenameGrid?: (path: string, gridId: string, name: string) => void;
  onRemoveGrid?: (path: string, gridId: string) => void;
  onSelectGrid?: (path: string, gridId: string) => void;
  onFocusPane?: (paneId: number) => void;
  gridMenuOpen: { path: string; gridId: string } | null;
  openGridMenu: (
    e: React.MouseEvent,
    path: string,
    grid: GridItem,
    canRemove: boolean,
    jumpNumber?: number,
  ) => void;
  setGridRenaming: (v: { path: string; gridId: string } | null) => void;
  renaming: string | null;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  checkoutBranches: ReadonlyMap<number, string>;
  railDiffByDir: ReadonlyMap<string, RailDiffTotals>;
  railPrByDir: ReadonlyMap<string, RailPrState>;
  railPrefs: RailPrefs;
  pinnedGridIds: ReadonlySet<string>;
  onRailPrefsChange: (prefs: RailPrefs) => void;
  onFilterTag: (tag: TagInfo) => void;
  onClearTagFilter: () => void;
  railOptionsAnchor: HTMLElement | null;
  setRailOptionsAnchor: (anchor: HTMLElement | null) => void;
  onAddGrid?: (path: string) => void;
  suppressGridClickRef: React.RefObject<boolean>;
  onGridPointerDown: (event: React.PointerEvent, workspace: string, gridId: string) => void;
  gridDragId: string | null;
  gridDrop: { gridId: string; position: 'before' | 'after' } | null;
  gridDragRefused: { key: string; reason: string } | null;
  hoverSuppressed: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onToggleGridUnread: (gridId: string, signature: string, unread: boolean) => void;
  isGridUnread: (gridId: string, agents: ReturnType<typeof buildRailCard>['agents']) => { unread: boolean; signature: string };
  onOpenInspector?: (paneId: number, tab: "changes" | "pull-request") => void;
}): React.JSX.Element {
  const [expandedGrids, setExpandedGrids] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const live = new Set(model.groups.flatMap((group) => group.cards.map(entryKey)));
    setExpandedGrids((current) => [...current].every((key) => live.has(key))
      ? current
      : new Set([...current].filter((key) => live.has(key))));
  }, [model]);
  const tagPopover = useTagPopover();
  const optionsTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const openManage = (): void => {
      const anchor = optionsTriggerRef.current;
      if (anchor) tagPopover.open({ anchor, view: 'manage', selectedTagIds: activeTagIds });
    };
    window.addEventListener(MANAGE_TAGS_EVENT, openManage);
    return () => window.removeEventListener(MANAGE_TAGS_EVENT, openManage);
  }, [tagPopover, activeTagIds]);
  const renderCard = ({ workspace, grid, paneIds, card }: RailEntry): React.JSX.Element => {
    const selectedCard = selected === workspace.path && selectedGridId === grid.id;
    const onRemove = onRemoveGrid
      ? () => onRemoveGrid(workspace.path, grid.id)
      : undefined
    const key = gridStorageKey(workspace.path, grid.id);
    const jumpNumber = model.jumpByKey.get(key) ?? 0;
    const unreadState = isGridUnread(key, card.agents);
    if (gridRenaming?.path === workspace.path && gridRenaming.gridId === grid.id && onRenameGrid) {
      return (
        <GridRenameRow
          key={key}
          cardMode={railPrefs.cardMode}
          selected={selectedCard}
          initial={grid.name}
          onSubmit={(name) => {
            setGridRenaming(null);
            onRenameGrid(workspace.path, grid.id, name.trim());
          }}
          onCancel={() => setGridRenaming(null)}
        />
      );
    }
    return (
      <Suspense
        key={key}
        fallback={
          <GridRailRowFallback
            name={grid.name}
            selected={selectedCard}
            jumpNumber={jumpNumber}
            cardMode={railPrefs.cardMode}
            onSelect={() => onSelectGrid?.(workspace.path, grid.id)}
            onContextMenu={(event) => openGridMenu(event, workspace.path, grid, Boolean(onRemove), jumpNumber)}
            onRemove={onRemove}
          />
        }
      >
        <LazyGridRailRow
          name={grid.name}
          workspace={workspace.path}
          gridId={grid.id}
          selected={selectedCard}
          onFocusPane={onFocusPane}
          expanded={expandedGrids.has(key)}
          onToggleExpanded={() => setExpandedGrids((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })}
          pinned={pinnedGridIds.has(key)}
          paneIds={paneIds}
          tags={(grid.tagIds ?? []).flatMap((id) => tagById.get(id) ?? [])}
          fallbackSessions={sessions}
          branches={checkoutBranches}
          diffByDir={railDiffByDir}
          prByDir={railPrByDir}
          cardMode={railPrefs.cardMode}
          tagDisplay={railPrefs.tagDisplay}
          agentActivity={railPrefs.agentActivity}
          properties={railPrefs.properties}
          unread={unreadState.unread}
          dragging={gridDragId === key}
          dragPosition={gridDrop?.gridId === key ? gridDrop.position : null}
          dragRefusal={gridDragRefused?.key === key ? gridDragRefused.reason : null}
          hoverSuppressed={hoverSuppressed}
          onGridPointerDown={onGridPointerDown}
          jumpNumber={jumpNumber}
          onSelect={() => {
            if (suppressGridClickRef.current) return
            onSelectGrid?.(workspace.path, grid.id)
          }}
          onToggleUnread={() => onToggleGridUnread(key, unreadState.signature, unreadState.unread)}
          onFilterTag={onFilterTag}
          onRemove={onRemove}
          onContextMenu={(event) => openGridMenu(event, workspace.path, grid, Boolean(onRemove), jumpNumber)}
          menuOpen={gridMenuOpen?.path === workspace.path && gridMenuOpen.gridId === grid.id}
          onOpenInspector={(paneId, tab) => onOpenInspector?.(paneId, tab)}
        />
      </Suspense>
    )
  };
  const toggleGroup = (group: string): void => onRailPrefsChange({
    ...railPrefs,
    collapsedGroups: railPrefs.collapsedGroups.includes(group)
      ? railPrefs.collapsedGroups.filter((entry) => entry !== group)
      : [...railPrefs.collapsedGroups, group],
  })
  const items: RailListItem[] = [];
  const showDropAt = visibleDropSlot(model.displayedWorkspaces, dragPath, wsDropIndex);
  for (const group of model.groups) {
    if (showDropAt !== null && group.kind === 'workspace' && group.wsIndex === showDropAt) {
      items.push({ key: 'ws-drop', kind: 'drop', content: <WorkspaceDropIndicator /> });
    }
    if (group.workspace) {
      const workspace = group.workspace;
      items.push({
        key: group.key,
        kind: 'group',
        content: (
          <WorkspaceRailGroupRow
            workspace={workspace}
            index={group.wsIndex}
            color={colorOf(workspace.path)}
            count={group.cards.length}
            hasGrids={group.cards.length > 0}
            collapsed={group.collapsed}
            selected={selected === workspace.path}
            highlighted={selected === workspace.path && !group.selectedCardListed}
            pinned={pinnedWorkspaces.has(workspace.path)}
            dragging={dragPath !== null}
            dragged={dragPath === workspace.path}
            renaming={renaming === workspace.path}
            dragActiveRef={dragActiveRef}
            startWsDrag={startWsDrag}
            onSelect={onSelectWorkspace}
            onToggle={toggleWsOpen}
            onOpenMenu={openMenu}
            onNewSession={onNewWorkspaceSession}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
          />
        ),
      });
    } else if (group.label) {
      items.push({
        key: group.key,
        kind: 'group',
        content: (
          <RailLabelGroupHeader
            label={group.label}
            kind={group.kind === 'pinned' ? 'pinned' : 'label'}
            groupBy={railPrefs.groupBy}
            count={group.cards.length}
            collapsed={group.collapsed}
            onToggle={() => toggleGroup(group.label)}
          />
        ),
      });
    }
    if (!group.collapsed) {
      for (const entry of group.cards) {
        items.push({ key: `card:${entryKey(entry)}`, kind: 'card', content: renderCard(entry) });
      }
    }
  }
  if (showDropAt !== null && showDropAt >= model.displayedWorkspaces.length) {
    items.push({ key: 'ws-drop', kind: 'drop', content: <WorkspaceDropIndicator /> });
  }
  if (items.length === 0) {
    items.push({
      key: 'empty',
      kind: 'group',
      content: (
        <EmptyListMessage>
          {railEmptyMessage({ workspaceCount: workspaces.length, filters: railPrefs.filters, activeTagIds })}
        </EmptyListMessage>
      ),
    })
  }
  return (
    <NavigationRailSection fill data-testid="rail-tree">
      <RailTreeHeader
        treeLabel={treeLabel}
        activeFilterCount={activeFilterCount}
        railOptionsAnchor={railOptionsAnchor}
        setRailOptionsAnchor={setRailOptionsAnchor}
        triggerRef={optionsTriggerRef}
        onAddWorkspace={onAddWorkspace}
        onSshConnect={onSshConnect}
        onAddGrid={onAddGrid && canAddGrid ? () => onAddGrid(selected) : undefined}
        railPrefs={railPrefs}
        onRailPrefsChange={onRailPrefsChange}
        activeTagIds={activeTagIds}
        tagById={tagById}
        onClearTagFilter={onClearTagFilter}
      />

      <RailActiveTagFilter tags={activeTagIds.flatMap((id) => tagById.get(id) ?? [])} onClear={onClearTagFilter} />
      <RailList
        items={items}
        selectedKey={selectedCardItemKey(selected, selectedGridId)}
        dragging={dragPath !== null || gridDragId !== null}
        refused={gridDragRefused !== null}
        scrollRef={scrollRef}
      />
    </NavigationRailSection>
  );
}

const NO_BRANCHES: ReadonlyMap<number, string> = new Map();
const NO_GRIDS: Record<string, GridItem[]> = {};
const NO_PATHS: ReadonlySet<string> = new Set();

// The open menu offers Locate only while the daemon reports its folder missing.
function withMissing(menu: CtxMenu, workspaces: readonly Workspace[]): CtxMenu {
  return { ...menu, missing: workspaces.find((w) => w.path === menu.path)?.missing };
}

export function Sidebar({
  mascotFirstRun = false,
  mascotWorkspacesEmpty,
  workspaces,
  sessions,
  finishedUnseen,
  selected,
  customColors,
  colorIndexByPath,
  renaming,
  onSelect,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameStart,
  onLocateStart,
  onOpenExternalError,
  onRenameSubmit,
  onRenameCancel,
  onReorderWorkspace,
  pinnedWorkspaces,
  onTogglePinWorkspace,
  notices,
  onSshConnect,
  railClient,
  checkoutBranches = NO_BRANCHES,
  onOpenInspector,
  gridsByWorkspace = NO_GRIDS,
  onSelectGrid,
  onFocusPane,
  selectedGridId = null,
  onNewWorkspaceSession,
  onAddGrid,
  onRenameGrid,
  onResetGridName,
  onRemoveGrid,
  onOpenSettings,
  currentRailView,
  onOpenPalette,
  paletteChord,
  onHideRail,
  chromeTheme,
  onToggleChromeTheme,
  updateVersion,
  agentAttention,
  taskTurnCount = 0,
  mergeQueueParked,
  className = "",
  gridArea,
  onHeadMouseDown,
  onHeadDoubleClick,
  tags: tagsProp,
  onSetGridTags,
  onTagCreate,
  onTagUpdate,
  onTagDelete,
}: Props): React.JSX.Element {
  const keymapOverrides = useContext(KeymapOverridesContext);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void preloadRailChunks();
      void preloadGridRailRow();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const [gridMenu, setGridMenu] = useState<GridCtxMenu | null>(null);
  const [gridRenaming, setGridRenaming] = useState<{
    path: string;
    gridId: string;
  } | null>(null);
  const [navMenu, setNavMenu] = useState<{
    x: number;
    y: number;
    originX: number;
    originY: number;
    view: RailView;
  } | null>(null);
  const [tagFilter, setTagFilter] = useState<number[]>(() =>
    loadTagFilter(),
  );
  // The tag filter only applies while cards show tags; a filter saved before that
  // coupling existed turns the property on instead of being discarded.
  const [railPrefs, setRailPrefs] = useState<RailPrefs>(() => {
    const prefs = loadRailPrefs();
    if (prefs.properties.includes('tags') || loadTagFilter().length === 0) return prefs;
    return { ...prefs, properties: [...prefs.properties, 'tags'], customisedProperties: true };
  });
  const [gridDragId, setGridDragId] = useState<string | null>(null);
  const [gridDrop, setGridDrop] = useState<{ gridId: string; position: 'before' | 'after' } | null>(null);
  const [gridDragRefused, setGridDragRefused] = useState<{ key: string; reason: string } | null>(null);
  const suppressGridClickRef = useRef(false);
  const [railOptionsAnchor, setRailOptionsAnchor] = useState<HTMLElement | null>(null);
  const [pinnedGridIds, setPinnedGridIds] = useState<Set<string>>(() => new Set(loadPinnedGridIds()));
  const pendingTagRestores = useRef<{ tag: TagInfo; gridIds: string[] }[]>([]);

  const settingsOpen = useSettingsOpen();
  const railPrByDir = useRailPrCache();
  const railDiffByDir = useRailGitCache();
  const railView = useRailView();
  const activeRailView = currentRailView ?? railView;
  const hiddenRailViews = useHiddenRailViews();
  const { custom, dataCustom } = useCustomSurface();
  const activeSettingsSection = useSettingsSection();

  const isGridUnread = (
    gridId: string,
    agents: ReturnType<typeof buildRailCard>['agents'],
  ): { unread: boolean; signature: string } => {
    const signature = railUnreadSignature(agents.map(({ session }) => ({
      id: session.id,
      inboxUnread: session.inbox_unread,
      childrenWaiting: session.children_waiting,
      finishedUnseen: finishedUnseen?.has(session.id) ?? false,
    })))
    return {
      unread: isRailGridUnread(railPrefs.gridUnreadOverrides, gridId, signature, agents.some((agent) => agent.unread)),
      signature,
    }
  };
  const undoable = useRailUndoActions({
    notices,
    workspaces,
    gridsByWorkspace,
    pinnedWorkspaces,
    onTogglePinWorkspace,
    pinnedGridIds,
    setPinnedGridIds,
    railPrefs,
    setRailPrefs,
  });
  const onToggleGridUnread = undoable.toggleGridUnread;

  useEffect(() => {
    const reorderSelected = (event: Event): void => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      if (railPrefs.sort !== 'manual' || (direction !== -1 && direction !== 1) || !selectedGridId) return;
      const ids = (gridsByWorkspace[selected] ?? []).map((grid) => gridStorageKey(selected, grid.id));
      const currentOrder = [...new Set([...railPrefs.gridOrder, ...allGridKeys(gridsByWorkspace)])];
      const current = currentOrder;
      const next = moveSelectedRailGrid(current, ids, gridStorageKey(selected, selectedGridId), direction);
      if (next.some((id, index) => id !== current[index])) setRailPrefs((prefs) => ({ ...prefs, gridOrder: next }));
    };
    window.addEventListener('houston:rail-reorder-selected-card', reorderSelected);
    return () => window.removeEventListener('houston:rail-reorder-selected-card', reorderSelected);
  }, [railPrefs, selectedGridId, selected, gridsByWorkspace]);

  useEffect(() => saveRailPrefs(railPrefs), [railPrefs]);
  useEffect(() => {
    const signatures = new Map<string, string>();
    for (const [path, grids] of Object.entries(gridsByWorkspace)) for (const grid of grids) {
      const gridSessions = (grid.sessionIds ?? []).flatMap((id) => {
        const session = sessions.find((candidate) => candidate.id === id);
        return session ? [session] : [];
      });
      if (gridSessions.length) signatures.set(gridStorageKey(path, grid.id), railUnreadSignature(gridSessions.map((session) => ({
        id: session.id,
        inboxUnread: session.inbox_unread,
        childrenWaiting: session.children_waiting,
        finishedUnseen: finishedUnseen?.has(session.id) ?? false,
      }))))
    }
    setRailPrefs((current) => {
      const gridUnreadOverrides = Object.fromEntries(Object.entries(current.gridUnreadOverrides).filter(
        ([gridId, override]) => !signatures.has(gridId) || signatures.get(gridId) === override.signature,
      ))
      return Object.keys(gridUnreadOverrides).length === Object.keys(current.gridUnreadOverrides).length
        ? current
        : { ...current, gridUnreadOverrides }
    });
  }, [gridsByWorkspace, sessions, finishedUnseen]);
  useEffect(() => {
    try {
      localStorage.setItem(GRID_PINNED_KEY, JSON.stringify([...pinnedGridIds]))
    } catch { /* Storage can be unavailable in private contexts. */ }
  }, [pinnedGridIds]);
  useEffect(() => {
    if (localStorage.getItem(GRID_PINNED_MIGRATION_KEY) === '1') return;
    if (Object.keys(gridsByWorkspace).length === 0 && (pinnedWorkspaces.size > 0 || workspaces.length > 0)) return;
    const known = workspaces.map((workspace) => ({ path: workspace.path, gridIds: (gridsByWorkspace[workspace.path] ?? []).map((grid) => grid.id) }));
    setPinnedGridIds(new Set(migratePinnedWorkspaces(known, pinnedWorkspaces)));
    setRailPrefs((current) => migrateRailGridKeys(current, known));
  }, [workspaces, gridsByWorkspace, pinnedWorkspaces]);

  const [treeFilter, setTreeFilter] = useState<string | null>(null);
  const tags = useMemo(() => tagsProp ?? [], [tagsProp]);
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const activeTagIds = useMemo(
    () => railPrefs.properties.includes('tags') ? tagFilter.filter((id) => tagById.has(id)) : [],
    [tagFilter, tagById, railPrefs.properties],
  );
  useEffect(() => {
    if (!railPrefs.properties.includes('tags') && tagFilter.length) setTagFilter([]);
  }, [railPrefs.properties, tagFilter]);
  const filteredWorkspaces = useMemo(
    () =>
      activeTagIds.length === 0
        ? workspaces
        : workspaces.filter((w) =>
            w.path === selected ||
            workspaceCarriesTag(
              w.path,
              gridsByWorkspace[w.path],
              sessions,
              activeTagIds,
            ),
          ),
    [workspaces, gridsByWorkspace, sessions, activeTagIds, selected],
  );

  const [wsCollapsed, setWsCollapsed] = useState<Set<string>>(() =>
    loadCollapsedWorkspaces(),
  );
  const toggleWsOpen = (path: string): void => {
    setWsCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveCollapsedWorkspaces(next);
      return next;
    });
  };
  // Selecting a workspace shows its grids; only the chevron collapses it.
  const selectWorkspace = (path: string): void => {
    setWsCollapsed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      saveCollapsedWorkspaces(next);
      return next;
    });
    onSelect(path);
  };

  // Rail state keyed by a workspace or grid that is gone would come back with a re-added path.
  // Only a workspace seen leaving the roster is dropped, and never a WSL one: its roster can be partial.
  const knownWorkspacePaths = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const current = new Set(workspaces.map((workspace) => workspace.path));
    const previous = knownWorkspacePaths.current;
    knownWorkspacePaths.current = current;
    if (!previous) return;
    const removed = new Set([...previous].filter((path) => !current.has(path) && !wslWorkspaces.has(path)));
    if (removed.size === 0) return;
    setWsCollapsed((prev) => {
      if (![...prev].some((path) => removed.has(path))) return prev;
      const next = new Set([...prev].filter((path) => !removed.has(path)));
      saveCollapsedWorkspaces(next);
      return next;
    });
    setPinnedGridIds((prev) => {
      const kept = [...prev].filter((key) => !isStaleGridKey(key, NO_GRIDS, removed));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    setRailPrefs((prev) => pruneRailGridState(prev, NO_GRIDS, removed));
  }, [workspaces]);
  useEffect(() => {
    setPinnedGridIds((prev) => {
      const kept = [...prev].filter((key) => !isStaleGridKey(key, gridsByWorkspace, NO_PATHS));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    setRailPrefs((prev) => pruneRailGridState(prev, gridsByWorkspace, NO_PATHS));
  }, [gridsByWorkspace]);

  const entries = useMemo(
    () => buildRailEntries({
      workspaces: filteredWorkspaces,
      gridsByWorkspace,
      activeTagIds,
      sessions,
      pinnedGridIds,
      branches: checkoutBranches,
      diffByDir: railDiffByDir,
      prByDir: railPrByDir,
      filters: railPrefs.filters,
      selected,
      selectedGridId,
      finishedUnseen,
    }),
    [filteredWorkspaces, gridsByWorkspace, activeTagIds, sessions, pinnedGridIds, checkoutBranches, railDiffByDir, railPrByDir, railPrefs.filters, selected, selectedGridId, finishedUnseen],
  );
  const settledEntries = useSettledSmartCards(entries, railPrefs.sort === 'smart');
  const settledCards = useMemo(
    () => new Map(settledEntries.map((entry) => [entryKey(entry), entry.card] as const)),
    [settledEntries],
  );
  const model = useMemo(
    () => layoutRailTree({
      entries,
      workspaces: filteredWorkspaces,
      gridsByWorkspace,
      prefs: railPrefs,
      activeTagIds,
      selected,
      selectedGridId,
      isWsOpen: (path) => !wsCollapsed.has(path),
      settled: settledCards,
    }),
    [entries, filteredWorkspaces, gridsByWorkspace, railPrefs, activeTagIds, selected, selectedGridId, wsCollapsed, settledCards],
  );

  // Alt+1..9 selects the Nth card in on-screen order, whichever card has focus.
  useAltDigitJump(
    model.jumpOrder,
    onSelectGrid && ((entry) => onSelectGrid(entry.path, entry.gridId)),
    !settingsOpen,
    keymapOverrides,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRead = useRef({ model, workspaces, pinnedWorkspaces, onReorderWorkspace, railPrefs, pinnedGridIds, gridsByWorkspace });
  dragRead.current = { model, workspaces, pinnedWorkspaces, onReorderWorkspace, railPrefs, pinnedGridIds, gridsByWorkspace };
  const dragResolveRef = useRef<(() => void) | null>(null);
  const autoScroll = useEdgeAutoScroll(scrollRef, () => dragResolveRef.current?.());

  const [dragPath, setDragPath] = useState<string | null>(null);
  const [wsDropIndex, setWsDropIndex] = useState<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const dragActiveRef = useRef(false);

  const startWsDrag = (e: React.PointerEvent, path: string): void => {
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let pointer = { x: startX, y: startY };
    const setDrop = (idx: number | null): void => {
      dropIndexRef.current = idx;
      setWsDropIndex(idx);
    };
    const resolve = (): void => {
      const container = scrollRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      if (pointer.x < bounds.left || pointer.x > bounds.right) {
        setDrop(null);
        return;
      }
      const { model: current, pinnedWorkspaces: pinned } = dragRead.current;
      const rows = [...container.querySelectorAll<HTMLElement>("[data-ws-idx]")].map((row) => row.getBoundingClientRect());
      const pinnedCount = current.displayedWorkspaces.filter((w) => pinned.has(w.path)).length;
      const idx = workspaceDropIndex(rows, pointer.y);
      setDrop(pinned.has(path) ? Math.min(idx, pinnedCount) : Math.max(idx, pinnedCount));
    };
    const move = (ev: PointerEvent): void => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        active = true;
        dragActiveRef.current = true;
        dragResolveRef.current = resolve;
        setDragPath(path);
      }
      resolve();
      autoScroll.track(ev.clientY);
    };
    const cleanup = (commit: boolean): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      autoScroll.stop();
      dragResolveRef.current = null;
      const { model: current, workspaces: all, pinnedWorkspaces: pinned, onReorderWorkspace: reorder } = dragRead.current;
      if (commit && active && dropIndexRef.current !== null) {
        reorder(
          path,
          translateFilteredDropIndex(all, current.displayedWorkspaces, pinned, path, dropIndexRef.current),
        );
      }
      setDragPath(null);
      setDrop(null);
    };
    const up = (): void => cleanup(true);
    const cancel = (): void => cleanup(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const startGridDrag = (event: React.PointerEvent, workspace: string, gridId: string): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const sourceKey = gridStorageKey(workspace, gridId);
    let active = false;
    let pointer = { x: startX, y: startY };
    let target: { gridId: string; position: 'before' | 'after'; workspace: string } | null = null;
    const refuse = (key: string, reason: string): void => {
      target = null;
      setGridDrop(null);
      setGridDragRefused({ key, reason });
    };
    const resolve = (): void => {
      const { railPrefs: prefs, pinnedGridIds: pinned } = dragRead.current;
      const row = document.elementFromPoint(pointer.x, pointer.y)?.closest('[data-rail-grid-id]') as HTMLElement | null;
      const targetId = row?.dataset.railGridId;
      const targetWorkspace = row?.dataset.railWorkspace;
      const targetKey = targetId && targetWorkspace ? gridStorageKey(targetWorkspace, targetId) : '';
      if (!row || !targetId || !targetWorkspace || targetKey === sourceKey) {
        target = null;
        setGridDrop(null);
        if (prefs.sort !== 'manual') setGridDragRefused({ key: sourceKey, reason: RAIL_DRAG_REFUSAL.notManual });
        else setGridDragRefused(null);
        return;
      }
      if (!canReorderRailGrid(prefs.sort, workspace, targetWorkspace)) {
        refuse(targetKey, prefs.sort !== 'manual' ? RAIL_DRAG_REFUSAL.notManual : RAIL_DRAG_REFUSAL.crossWorkspace);
        return;
      }
      if (pinned.has(sourceKey) !== pinned.has(targetKey)) {
        refuse(targetKey, RAIL_DRAG_REFUSAL.pinState);
        return;
      }
      const rect = row.getBoundingClientRect();
      const position = pointer.y < rect.top + rect.height / 2 ? 'before' : 'after';
      target = { gridId: targetKey, position, workspace: targetWorkspace };
      setGridDrop({ gridId: targetKey, position });
      setGridDragRefused(null);
    };
    const move = (ev: PointerEvent): void => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        active = true;
        dragResolveRef.current = resolve;
        setGridDragId(sourceKey);
      }
      resolve();
      autoScroll.track(ev.clientY);
    };
    const cleanup = (commit: boolean): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      autoScroll.stop();
      dragResolveRef.current = null;
      if (commit && active && target?.workspace === workspace && target.gridId !== sourceKey) {
        const { railPrefs: prefs, gridsByWorkspace: grids } = dragRead.current;
        const order = [...new Set([...prefs.gridOrder, ...allGridKeys(grids)])];
        const next = reorderRailGrid(order, sourceKey, target.gridId, target.position === 'before');
        setRailPrefs((current) => ({ ...current, gridOrder: next }));
      }
      // Any drag swallows the click that follows its release, whether or not it reordered.
      if (active) {
        suppressGridClickRef.current = true;
        window.setTimeout(() => { suppressGridClickRef.current = false; }, 0);
      }
      setGridDragId(null);
      setGridDrop(null);
      setGridDragRefused(null);
    };
    const up = (): void => cleanup(true);
    const cancel = (): void => cleanup(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const colorOf = (path: string): string =>
    customColors[path] ?? workspaceColor(colorIndexByPath[path] ?? 0);

  const closeMenus = (): void => {
    setMenu(null);
    setGridMenu(null);
    setNavMenu(null);
  };

  const openMenu = (e: React.MouseEvent, w: Workspace, color: string): void => {
    e.preventDefault();
    setGridMenu(null);
    setNavMenu(null);
    // A folder moved while the app ran shows as missing once the daemon restats it.
    if (onLocateStart) railClient?.send({ type: "workspace_list" });
    setMenu({
      x: e.clientX,
      y: e.clientY,
      path: w.path,
      name: w.name,
      color,
      pinned: pinnedWorkspaces.has(w.path),
      selected: w.path === selected,
    });
  };

  const selectRailView = (v: RailView): void => {
    setSettingsOpen(false);
    toggleRailView(v);
  };

  const openNavMenu = (e: React.MouseEvent, v: RailView): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    setGridMenu(null);
    const x = Math.min(e.clientX, window.innerWidth - 244);
    const y = Math.min(e.clientY, window.innerHeight - 100);
    setNavMenu({ x, y, originX: e.clientX - x, originY: e.clientY - y, view: v });
  };

  const openGridMenu = (
    e: React.MouseEvent,
    path: string,
    grid: GridItem,
    canRemove: boolean,
    jumpNumber?: number,
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    setNavMenu(null);
    const x = e.clientX;
    const y = e.clientY;
    const key = gridStorageKey(path, grid.id);
    const card = buildRailCard({
      gridId: grid.id,
      workspace: path,
      title: grid.name,
      pinned: pinnedGridIds.has(key),
      paneIds: grid.sessionIds ?? [],
      sessions,
      branches: checkoutBranches,
      diffByDir: railDiffByDir,
      prByDir: railPrByDir,
    });
    setGridMenu({
      x,
      y,
      originX: e.clientX - x,
      originY: e.clientY - y,
      path,
      gridId: grid.id,
      name: grid.name,
      canRemove,
      jumpNumber,
      pinned: pinnedGridIds.has(key),
      userNamed: grid.userNamed ?? false,
      tagIds: grid.tagIds ?? [],
      tagNames: tags.filter((tag) => grid.tagIds?.includes(tag.id)).map((tag) => tag.name),
      agentCount: gridAgentCount(grid),
      ...railGridContextFacts(card, path),
    });
  };

  const toggleGridPin = undoable.toggleGridPin;

  useEffect(() => {
    localStorage.setItem(TAG_FILTER_KEY, JSON.stringify(activeTagIds));
  }, [activeTagIds]);
  // However many tags are selected, the tag filter counts once.
  const activeFilterCount = Number(activeTagIds.length > 0) +
    Number(railPrefs.filters.hideIdle) +
    Number(railPrefs.filters.hideDefaultBranch) +
    Number(railPrefs.filters.hideEmptyGrids)

  const tagPopoverGrids = useMemo<TagGrid[]>(
    () => Object.entries(gridsByWorkspace).flatMap(([path, grids]) => grids.map((grid) => ({
      id: gridStorageKey(path, grid.id),
      title: grid.name,
      tags: grid.tagIds ?? [],
    }))),
    [gridsByWorkspace],
  )
  const tagGridTargets = useMemo(
    () => new Map(Object.entries(gridsByWorkspace).flatMap(([path, grids]) =>
      grids.map((grid) => [gridStorageKey(path, grid.id), { path, gridId: grid.id }] as const))),
    [gridsByWorkspace],
  )
  useEffect(() => {
    const pending = pendingTagRestores.current;
    const remaining: typeof pending = [];
    for (const restore of pending) {
      const restored = tags.find((tag) => tag.id !== restore.tag.id && tag.name === restore.tag.name && tag.color === restore.tag.color);
      if (!restored) {
        remaining.push(restore);
        continue;
      }
      for (const gridId of restore.gridIds) {
        const grid = tagPopoverGrids.find((entry) => entry.id === gridId);
        const target = tagGridTargets.get(gridId);
        if (grid && target) onSetGridTags?.(target.path, target.gridId, [...grid.tags.filter((id) => id !== restore.tag.id), restored.id]);
      }
    }
    pendingTagRestores.current = remaining;
  }, [tags, tagPopoverGrids, tagGridTargets, onSetGridTags]);

  const menuEl = menu && (
    <WorkspaceContextMenu
      menu={withMissing(menu, workspaces)}
      onClose={() => setMenu(null)}
      onAddGrid={onAddGrid}
      onRenameStart={onRenameStart}
      onRemoveWorkspace={onRemoveWorkspace}
      onLocateStart={onLocateStart}
      onOpenExternalError={onOpenExternalError}
      onTogglePin={undoable.togglePinWorkspace}
    />
  );

  const closeGrids = useMemo(
    () => Object.fromEntries(Object.entries(gridsByWorkspace).map(([path, grids]) => [
      path,
      grids.map((grid) => ({ ...grid, childCount: countGridChildren(sessions, grid.sessionIds ?? []) })),
    ])),
    [gridsByWorkspace, sessions],
  );
  const { removeGrid, closingLastEl } = useGridCloseConfirm(closeGrids, onRemoveGrid);
  // Closing the selected grid selects its neighbour in the order the rail shows.
  const removeGridFromRail = removeGrid && ((path: string, gridId: string): void => {
    const next = selected === path && selectedGridId === gridId ? neighbourGridId(model, path, gridId) : null;
    removeGrid(path, gridId, next ?? undefined);
  });

  const gridMenuEl = gridMenu && (
    <GridContextMenu
      gridMenu={gridMenu}
      onClose={() => setGridMenu(null)}
      onOpenGrid={onSelectGrid}
      onStartRename={(path, gridId) => setGridRenaming({ path, gridId })}
      onResetName={onResetGridName}
      onRemoveGrid={removeGridFromRail}
      onTogglePin={toggleGridPin}
      onOpenInspector={onOpenInspector}
      onError={onOpenExternalError}
    />
  );

  const navMenuEl = (
    <NavViewMenu
      navMenu={navMenu}
      onClose={() => setNavMenu(null)}
      onHide={undoable.hideView}
    />
  );

  const treeLabel = railPrefs.groupBy === 'workspace' ? 'Workspaces' : 'Grids';

  const settingsSections = NAVIGABLE_SETTINGS_SECTIONS;

  return (
    <TagPopoverHost
      tags={tags}
      grids={tagPopoverGrids}
      actions={{
        onCreate: (name, color) => {
          const created = { id: Math.max(0, ...tags.map((tag) => tag.id)) + 1, name, color };
          onTagCreate?.(name, color);
          return created;
        },
        onUpdate: (id, name, color) => onTagUpdate?.(id, name, color),
        onDelete: (id) => onTagDelete?.(id),
        onRestore: (tag, gridIds) => {
          pendingTagRestores.current.push({ tag, gridIds });
          onTagCreate?.(tag.name, tag.color);
        },
        onApply: (gridId, tagIds) => {
          const target = tagGridTargets.get(gridId);
          if (target) onSetGridTags?.(target.path, target.gridId, tagIds);
        },
        onFilter: (tagIds) => setTagFilter(tagIds),
      }}
    >
    <RailMenuDismiss open={menu !== null || gridMenu !== null || navMenu !== null} onCloseAll={closeMenus} />
    <RailSurface
      data-grid-area={gridArea}
      data-custom={dataCustom}
      custom={custom}
      className={className}
    >
      <RailHead
        onHeadMouseDown={onHeadMouseDown}
        onHeadDoubleClick={onHeadDoubleClick}
        onHideRail={onHideRail}
      />
      <Suspense fallback={null}><GridRailGitSubscription client={railClient ?? null} sessions={sessions} /></Suspense>
      {}
      {!settingsOpen && (
        <RailNav
          view={activeRailView}
          hidden={hiddenRailViews}
          paletteChord={paletteChord}
          taskTurnCount={taskTurnCount}
          mergeQueueParked={mergeQueueParked}
          onOpenPalette={onOpenPalette ?? (() => {})}
          onSelect={selectRailView}
          onRowMenu={openNavMenu}
        />
      )}
      <NavigationRailScroll>
        {settingsOpen ? (
          <SettingsTree
            treeFilter={treeFilter}
            setTreeFilter={setTreeFilter}
            settingsSections={settingsSections}
            activeSettingsSection={activeSettingsSection}
            attention={agentAttention}
          />
        ) : (
          <RailTree
            treeLabel={treeLabel}
            activeFilterCount={activeFilterCount}
            onSshConnect={onSshConnect}
            onOpenInspector={onOpenInspector}
            checkoutBranches={checkoutBranches}
            railDiffByDir={railDiffByDir}
            railPrByDir={railPrByDir}
            onAddGrid={onAddGrid}
            canAddGrid={workspaces.some((workspace) => workspace.path === selected)}
            railPrefs={railPrefs}
            pinnedGridIds={pinnedGridIds}
            onRailPrefsChange={(next) => setRailPrefs(next)}
            onFilterTag={(tag) => setTagFilter([tag.id])}
            onClearTagFilter={() => setTagFilter([])}
            railOptionsAnchor={railOptionsAnchor}
            setRailOptionsAnchor={setRailOptionsAnchor}
            suppressGridClickRef={suppressGridClickRef}
            gridDragId={gridDragId}
            gridDrop={gridDrop}
            gridDragRefused={gridDragRefused}
            hoverSuppressed={[menu, gridMenu, navMenu, gridDragId, dragPath].some((owner) => owner !== null)}
            scrollRef={scrollRef}
            onGridPointerDown={startGridDrag}
            onToggleGridUnread={onToggleGridUnread}
            isGridUnread={isGridUnread}
            onAddWorkspace={onAddWorkspace}
            selected={selected}
            model={model}
            workspaces={workspaces}
            pinnedWorkspaces={pinnedWorkspaces}
            sessions={sessions}
            colorOf={colorOf}
            activeTagIds={activeTagIds}
            tagById={tagById}
            dragPath={dragPath}
            wsDropIndex={wsDropIndex}
            dragActiveRef={dragActiveRef}
            startWsDrag={startWsDrag}
            onSelectWorkspace={selectWorkspace}
            toggleWsOpen={toggleWsOpen}
            openMenu={openMenu}
            onNewWorkspaceSession={onNewWorkspaceSession}
            selectedGridId={selectedGridId}
            gridRenaming={gridRenaming}
            onRenameGrid={onRenameGrid}
            onRemoveGrid={removeGridFromRail}
            onSelectGrid={onSelectGrid}
            onFocusPane={onFocusPane}
            openGridMenu={openGridMenu}
            gridMenuOpen={gridMenu}
            setGridRenaming={setGridRenaming}
            renaming={renaming}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
          />
        )}
      </NavigationRailScroll>

      <MascotMount existingUser={workspaces.length > 0} firstRun={mascotFirstRun} workspacesEmpty={mascotWorkspacesEmpty} />
      <NavigationRailFooter>
        <SettingsFooterItem attention={agentAttention?.total} onClick={onOpenSettings} />
        <ThemeToggle chromeTheme={chromeTheme} onToggle={onToggleChromeTheme} />
        <RailUpdateButton version={updateVersion} />
      </NavigationRailFooter>

      {portalOrNull(menuEl)}
      {portalOrNull(gridMenuEl)}
      {portalOrNull(closingLastEl)}
      {portalOrNull(navMenuEl)}
    </RailSurface>
    </TagPopoverHost>
  );
}
