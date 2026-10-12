import { SettingsFooterItem } from './ui/SettingsFooterItem'
import type { AgentAttention } from '../useAgentAttention'
import { HintKey } from './ui/ShortcutHint'
import { SettingsNavigationGroup } from './ui/NavigationRailFooter'
import { GLYPH_FOR_VERB } from './verbGlyphs'
import { MascotMount } from '../mascot/MascotMount'
import type { TagInfo } from "../houston/generated/TagInfo";
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { HoustonClient, PrInfo, SessionInfo, Workspace } from "../houston/client";
import type { ChromeTheme } from "../theme";
import {
  setSettingsOpen,
  setSettingsSection,
  useSettingsOpen,
  useSettingsSection,
} from "../settingsNav";
import { useCustomSurface } from "./customChrome";
import {
  NAVIGABLE_SETTINGS_SECTIONS,
  type SettingsSectionDef,
} from "../settingsSections";
import { searchSettingsRows } from "../settingsRowRegistry";
import { requestSettingsRowJump } from "../settingsRowJump";
import { translateFilteredDropIndex } from "../layout/wsOrder";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconChevronRight,
  IconChevronLeft,
  IconClose,
  IconCompass,
  IconPlug,
  IconCodeXml,
  IconDatabase,
  IconEyeOff,
  IconFolder,
  IconFolderPlus,
  IconGitFork,
  IconGitPullRequest,
  IconGrid,
  IconInfo,
  IconWrench,
  IconKeyboard,
  IconMic,
  IconMessageSquare,
  IconMoon,
  IconPanelLeft,
  IconPalette,
  IconPencil,
  IconPin,
  IconPlus,
  IconSun,
  IconSliders,
  IconTag,
  IconServer,
  IconPhone,
  IconTux,
  IconUser,
  IconTarget,
  IconTasks,
  IconChartArea,
  IconTerminal,
  IconZap,
  IconClock,
  type IconProps,
} from "./icons";
import { Tooltip } from "./ui/Tooltip";
import { gridAgentCount, useGridCloseConfirm } from "./rail/LastGridConfirm";
import { NavigationRailHeader } from "./ui/NavigationRail";
import logoUrl from "../assets/brand-mark";
import { showItemInFolder } from "../houston/bridge";
import { OpenInMenu } from "./OpenInMenu";
import { Icon } from "./ui/Icon";
import { Count } from "./ui/Count";
import { wslWorkspaces } from "../houston/environments";
import {
  RAIL_VIEWS,
  RAIL_VIEW_LABEL,
  setRailViewHidden,
  toggleRailView,
  useHiddenRailViews,
  useRailView,
  type RailView,
} from "../railView";
import { Button } from "./ui/Button";
import { NavigationRailFooter, NavigationRailScroll, SettingsNavigation } from "./ui/NavigationRailFooter";
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
import { GridRailRowFallback } from "./ui/GridRailRowFallback";
import { SettingsRailRow } from "./ui/SettingsRailRow";
import { SettingsSearch } from "./ui/SettingsSearch";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuHeading,
  ContextMenuItems,
  ContextMenuSeparator,
} from "./ui/ContextMenu";
import { usePointerMenuPosition } from "./ui/usePointerMenuPosition";
import { GridRailContextActions } from "./ui/GridRailContextActions";
import {
  WorkspaceTreeRow,
  WorkspaceTreeLabel,
  WorkspaceTreeActions,
  WorkspaceTreeAuxButton,
  EmptyListMessage,
} from "./ui/WorkspaceTreeRow";
import { TextInput } from "./ui/TextInput";
import {
  canReorderRailGrid,
  GRID_PINNED_KEY,
  GRID_PINNED_MIGRATION_KEY,
  isRailGridUnread,
  loadPinnedGridIds,
  migratePinnedWorkspaces,
  migrateRailGridKeys,
  migrateRailPrefs,
  moveSelectedRailGrid,
  railUnreadSignature,
  reorderRailGrid,
  saveRailPrefs,
  toggleRailGridRead,
  type RailPrefs,
} from "../railPrefs";
import { gridStorageKey, isAutoNameable } from "../layout/tree";
import { TagPopoverHost, useTagPopover, type TagGrid } from "./tags/TagPopover";

/** Window event that opens tag management anchored to the rail Options button. */
export const MANAGE_TAGS_EVENT = "houston:open-manage-tags";
import { buildRailCard } from "./rail/railCardModel";
import { RailVirtualList, type RailVirtualItem } from "./rail/RailVirtualList";
import {
  RailChevron,
  RailContextMenu,
  RailFilterCountBadge,
  RailActiveTagFilter,
  RailMenuValue,
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

const SETTINGS_ICON_MAP: Record<string, (p: IconProps) => React.JSX.Element> = {
  palette: IconPalette,
  terminal: IconTerminal,
  keyboard: IconKeyboard,
  user: IconUser,
  bell: GLYPH_FOR_VERB.notifications,
  folder: IconFolder,
  fork: IconGitFork,
  tasks: IconTasks,
  message: IconMessageSquare,
  mic: IconMic,
  database: IconDatabase,
  chart: IconChartArea,
  target: IconTarget,
  info: IconInfo,
  wrench: IconWrench,
  server: IconServer,
  phone: IconPhone,
  compass: IconCompass,
  sparkles: IconZap,
  plug: IconPlug,
  history: IconClock,
};

const GridRailGitSubscription = lazy(() =>
  import("./git/GridRailGitSubscription").then((module) => ({ default: module.GridRailGitSubscription })),
);
const GridRailExtraActions = lazy(() => import("./ui/GridRailExtraActions").then((module) => ({ default: module.GridRailExtraActions })));
const LazyGridRailRow = lazy(() => import("./ui/GridRailRow").then((module) => ({ default: module.GridRailRow })));
const railOptionsMenu = preloadable(() => import("./rail/RailOptionsMenu").then((module) => module.RailOptionsMenu));
export const preloadRailOptionsMenu = railOptionsMenu.preload;
const RailOptionsMenu = railOptionsMenu.Slot;

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

function WorkspaceRailGroupRow({
  workspace,
  count,
  hasGrids,
  index,
  color,
  collapsed,
  selected,
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
  pinned: boolean;
  dragging: boolean;
  dragged: boolean;
  renaming: boolean;
  dragActiveRef: React.RefObject<boolean>;
  startWsDrag: (event: React.PointerEvent, path: string) => void;
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
        selected={selected}
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
          if (selected) onToggle(workspace.path);
          else onSelect(workspace.path);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (selected) onToggle(workspace.path);
          else onSelect(workspace.path);
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
  selected: string;
  customColors: Record<string, string>;
  colorIndexByPath: Record<string, number>;
  renaming: string | null;
  onSelect: (key: string) => void;
  onAddWorkspace: () => void;
  onRemoveWorkspace: (path: string) => void;
  onRenameStart: (path: string) => void;
  onOpenExternalError?: (message: string) => void;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  onChangeColor: (path: string, color: string) => void;
  onReorderWorkspace: (fromPath: string, toIndex: number) => void;
  pinnedWorkspaces: ReadonlySet<string>;
  onTogglePinWorkspace: (path: string) => void;
  onSshConnect: () => void;
  railClient?: HoustonClient | null;
  checkoutBranches?: ReadonlyMap<number, string>;
  onOpenInspector?: (paneId: number, tab: "changes" | "pull-request") => void;

  gridsByWorkspace?: Record<
    string,
    {
      id: string;
      name: string;
      count?: number;
      state?: GridItem["state"];
      statusLabel?: string;
      sessionIds?: number[];
      tagIds?: number[];
      paneTagIds?: number[];
    }[]
  >;
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
  onRemoveGrid?: (path: string, gridId: string) => void;

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

interface CtxMenu {
  x: number;
  y: number;
  originX: number;
  originY: number;
  path: string;
  name: string;
  color: string;
  pinned: boolean;
}

interface GridCtxMenu {
  x: number;
  y: number;
  originX: number;
  originY: number;
  path: string;
  gridId: string;
  name: string;
  canRemove: boolean;
  pinned: boolean;
  tagIds: number[];
  tagNames: string[];
  agentCount: number;
  jumpNumber?: number;
  paneId: number | null;
  branch: string | null;
  checkoutPath: string;
  worktreePath: string | null;
  pr: PrInfo | null;
  gh: string | null;
}

function railGridContextFacts(
  grid: GridItem,
  workspacePath: string,
  sessions: SessionInfo[],
  branches: ReadonlyMap<number, string>,
  prs: ReadonlyMap<string, RailPrState>,
): Pick<GridCtxMenu, "paneId" | "branch" | "checkoutPath" | "worktreePath" | "pr" | "gh"> {
  const orValue = <T,>(value: T | null | undefined, fallback: T): T => value ?? fallback;
  const nullable = <T,>(value: T | undefined): T | null => value ?? null;
  const paneIds = orValue(grid.sessionIds, []);
  let pane: SessionInfo | undefined;
  for (const session of sessions) {
    if (!paneIds.includes(session.id)) continue;
    pane = session;
    break;
  }
  const checkoutPath = orValue(pane?.worktree?.path, orValue(pane?.checkout_root, orValue(pane?.cwd, workspacePath)));
  const prStatus = prs.get(checkoutPath);
  return {
    paneId: nullable(pane?.id),
    branch: pane ? orValue(pane.checkout?.branch, orValue(branches.get(pane.id), orValue(pane.worktree?.branch, null))) : null,
    checkoutPath,
    worktreePath: nullable(pane?.worktree?.path),
    pr: nullable(prStatus?.pr),
    gh: nullable(prStatus?.gh),
  };
}

function ctxHeader(title: string, subtitle: string): React.JSX.Element {
  return <ContextMenuHeading title={title} subtitle={subtitle} />;
}

const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
  if (
    e.key !== "ArrowDown" &&
    e.key !== "ArrowUp" &&
    e.key !== "Home" &&
    e.key !== "End"
  )
    return;
  e.preventDefault();
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
      ".ctx-item:not(:disabled)",
    ),
  ];
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  else if (e.key === "ArrowDown")
    next = current < 0 ? 0 : (current + 1) % items.length;
  else
    next =
      current < 0
        ? items.length - 1
        : (current - 1 + items.length) % items.length;
  items[next].focus();
};

function portalOrNull(el: React.ReactElement | null): React.ReactPortal | null {
  return el && createPortal(el, document.body);
}

function WorkspaceContextMenu({
  menu,
  onClose,
  onAddGrid,
  onRenameStart,
  onRemoveWorkspace,
  onOpenExternalError,
  onTogglePin,
}: {
  menu: CtxMenu;
  onClose: () => void;
  onAddGrid?: (path: string) => void;
  onRenameStart: (path: string) => void;
  onRemoveWorkspace: (path: string) => void;
  onOpenExternalError?: (message: string) => void;
  onTogglePin: (path: string) => void;
}): React.JSX.Element {
  return (
    <ContextMenu
      className=""
      style={{
        top: menu.y,
        left: menu.x,
        ["--pop-origin-x" as string]: `${menu.originX}px`,
        ["--pop-origin-y" as string]: `${menu.originY}px`,
      }}
      role="menu"
      onKeyDown={handleMenuKeyDown}
    >
      {ctxHeader(menu.name, menu.path)}
      <ContextMenuItems>
        {onAddGrid && (
          <ContextMenuItem

            role="menuitem"
            data-testid="ws-new-grid"
            onClick={() => {
              const { path } = menu;
              onClose();
              onAddGrid(path);
            }}
          >
            <Icon glyph={IconPlus} role="ui" />
            <span>New grid</span>
          </ContextMenuItem>
        )}
        <ContextMenuItem

          role="menuitem"
          onClick={() => {
            onClose();
            onRenameStart(menu.path);
          }}
        >
          <Icon glyph={IconPencil} role="ui" />
          <span>Rename workspace</span>
          <kbd>F2</kbd>
        </ContextMenuItem>
        <ContextMenuItem

          role="menuitem"
          data-testid="ws-toggle-pin"
          onClick={() => {
            const { path } = menu;
            onClose();
            onTogglePin(path);
          }}
        >
          <Icon glyph={IconPin} role="ui" />
          <span>{menu.pinned ? "Unpin workspace" : "Pin workspace"}</span>
        </ContextMenuItem>
        <ContextMenuItem

          role="menuitem"
          onClick={() => {
            const { path } = menu;
            onClose();
            void showItemInFolder(path);
          }}
        >
          <Icon glyph={IconFolder} role="ui" />
          <span>Reveal in Files</span>
        </ContextMenuItem>
        <OpenInMenu
          path={menu.path}
          label="Open workspace in"
          icon={<Icon glyph={IconCodeXml} role="ui" />}
          itemClass="ctx-item"
          onDone={onClose}
          onError={onOpenExternalError ?? (() => {})}
        />
        <ContextMenuSeparator />
        <ContextMenuItem danger

          role="menuitem"
          onClick={() => {
            onClose();
            onRemoveWorkspace(menu.path);
          }}
        >
          <Icon glyph={IconClose} role="ui" />
          <span>Remove workspace</span>
          <kbd>Ctrl+Shift+W</kbd>
        </ContextMenuItem>
      </ContextMenuItems>
    </ContextMenu>
  );
}

function GridContextMenu({
  gridMenu,
  onClose,
  onOpenGrid,
  onStartRename,
  onRemoveGrid,
  onTogglePin,
  onOpenInspector,
  onError,
}: {
  gridMenu: GridCtxMenu;
  onClose: () => void;
  onOpenGrid?: (path: string, gridId: string) => void;
  onStartRename: (path: string, gridId: string) => void;
  onRemoveGrid?: (path: string, gridId: string) => void;
  onTogglePin: (path: string, gridId: string) => void;
  onOpenInspector?: (paneId: number, tab: "pull-request") => void;
  onError?: (message: string) => void;
}): React.JSX.Element {
  const tagPopover = useTagPopover();
  const menuRef = useRef<HTMLDivElement>(null);
  const position = usePointerMenuPosition(menuRef, gridMenu.x, gridMenu.y);
  return (
    <RailContextMenu
      variant="grid-card"
      ref={menuRef}
      aria-label={`${gridMenu.name} actions`}
      style={{
        ...position,
        ["--pop-origin-x" as string]: `${gridMenu.x - position.left}px`,
        ["--pop-origin-y" as string]: `${gridMenu.y - position.top}px`,
      }}
      role="menu"
      onKeyDown={handleMenuKeyDown}
    >
      <ContextMenuItems>
        <ContextMenuItem role="menuitem" onClick={() => {
          onOpenGrid?.(gridMenu.path, gridMenu.gridId);
          onClose();
        }}>
          <Icon glyph={IconGrid} role="ui" />
          <span>Open</span>
          {gridMenu.jumpNumber != null && gridMenu.jumpNumber <= 9 && <RailMenuValue><kbd>Alt {gridMenu.jumpNumber}</kbd></RailMenuValue>}
        </ContextMenuItem>
        <ContextMenuItem role="menuitem" onClick={() => {
          onStartRename(gridMenu.path, gridMenu.gridId);
          onClose();
        }}>
          <Icon glyph={IconPencil} role="ui" />
          <span>Rename</span>
        </ContextMenuItem>
        <ContextMenuItem role="menuitem" data-testid="menu-grid-pin" onClick={() => { onTogglePin(gridMenu.path, gridMenu.gridId); onClose() }}>
          <Icon glyph={IconPin} role="ui" />
          <span>{gridMenu.pinned ? "Unpin" : "Pin to top"}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem role="menuitem" aria-haspopup="dialog" data-testid="menu-tags-entry" onClick={(event) => {
          tagPopover.open({ anchor: event.currentTarget, gridId: gridStorageKey(gridMenu.path, gridMenu.gridId), view: 'pick', placement: 'right', onDismiss: onClose });
        }}>
          <Icon glyph={IconTag} role="ui" />
          <span className="flex-1">Tags</span>
          <RailMenuValue>{gridMenu.tagNames.join(", ")}<Icon glyph={IconChevronRight} role="small" /></RailMenuValue>
        </ContextMenuItem>
        <GridRailContextActions branch={gridMenu.branch} onClose={onClose} onError={onError} />
        <ContextMenuSeparator />
        <Suspense fallback={null}>
          <GridRailExtraActions
            paneId={gridMenu.paneId}
            checkoutPath={gridMenu.checkoutPath}
            worktreePath={gridMenu.worktreePath}
            pr={gridMenu.pr}
            gh={gridMenu.gh}
            onClose={onClose}
            onOpenInspector={onOpenInspector}
            onError={onError}
          />
        </Suspense>
        <ContextMenuSeparator />
        {gridMenu.canRemove && <ContextMenuItem danger role="menuitem" onClick={() => {
            const { path, gridId } = gridMenu;
            onClose();
            onRemoveGrid?.(path, gridId);
        }}>
          <Icon glyph={IconClose} role="ui" />
          <span>{gridMenu.agentCount > 0 ? `Close grid and its ${gridMenu.agentCount} ${gridMenu.agentCount === 1 ? "agent" : "agents"}…` : "Close grid"}</span>
        </ContextMenuItem>}
      </ContextMenuItems>
    </RailContextMenu>
  );
}

function allGridKeys(gridsByWorkspace: Record<string, { id: string }[]>): string[] {
  return Object.entries(gridsByWorkspace).flatMap(([path, grids]) => grids.map((grid) => gridStorageKey(path, grid.id)));
}

type GridItem = {
  id: string;
  name: string;
  count?: number;
  state?: "starting" | "working" | "needs-input" | "idle" | "unavailable" | "stopped";
  statusLabel?: string;
  sessionIds?: number[];
  tagIds?: number[];
  paneTagIds?: number[];
};

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

// A tab whose own and panes' tags carry no active tag leaves the rail. Unknown
// pane membership (paneTagIds undefined) stays: never hide what it cannot see.
function hiddenByTagFilter(
  g: Pick<GridItem, "tagIds" | "paneTagIds">,
  activeTagIds: number[],
): boolean {
  if (activeTagIds.length === 0) return false;
  const carries = (ids: number[] | undefined): boolean =>
    ids?.some((id) => activeTagIds.includes(id)) ?? false;
  if (carries(g.tagIds)) return false;
  return g.paneTagIds !== undefined && !carries(g.paneTagIds);
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

function RailNav({
  view,
  hidden,
  paletteChord,
  taskTurnCount,
  onOpenPalette,
  onSelect,
  onRowMenu,
}: {
  view: RailView | null;
  hidden: ReadonlySet<RailView>;
  paletteChord: string | null | undefined;
  taskTurnCount: number;
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
            trailing={
v === "tasks" && taskTurnCount > 0 ? <Count value={taskTurnCount} from="warn" /> : null
            }
          />
        );
      })}
    </NavigationRail>
  );
}

function NavViewMenu({
  navMenu,
  onClose,
  onHide,
}: {
  navMenu: {
    x: number;
    y: number;
    originX: number;
    originY: number;
    view: RailView;
  } | null;
  onClose: () => void;
  onHide: (v: RailView) => void;
}): React.JSX.Element | null {
  if (navMenu === null) return null;
  return (
    <ContextMenu
      className=""
      style={{
        top: navMenu.y,
        left: navMenu.x,
        ["--pop-origin-x" as string]: `${navMenu.originX}px`,
        ["--pop-origin-y" as string]: `${navMenu.originY}px`,
      }}
      role="menu"
      onKeyDown={handleMenuKeyDown}
    >
      {ctxHeader(RAIL_VIEW_LABEL[navMenu.view], "Sidebar")}
      <ContextMenuItems>
        <ContextMenuItem

          role="menuitem"
          data-testid="nav-hide-row"
          onClick={() => {
            onHide(navMenu.view);
            onClose();
          }}
        >
          <Icon glyph={IconEyeOff} role="ui" />
          <span>Hide from sidebar</span>
        </ContextMenuItem>
      </ContextMenuItems>
    </ContextMenu>
  );
}

function SettingsTree({
  treeFilter,
  setTreeFilter,
  settingsSections,
  activeSettingsSection,
  attention,
}: {
  treeFilter: string | null;
  setTreeFilter: (
    v: string | null | ((cur: string | null) => string | null),
  ) => void;
  settingsSections: readonly SettingsSectionDef[];
  activeSettingsSection: string;
  attention?: AgentAttention;
}): React.JSX.Element {
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]')) return;
        e.preventDefault();
        e.stopPropagation();
        if (treeFilter) setTreeFilter(null);
        else setSettingsOpen(false);
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      e.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [treeFilter, setTreeFilter]);
  const query = (treeFilter ?? '').trim().toLowerCase();
  const rowHits = query ? searchSettingsRows(query) : [];
  const sections = settingsSections.filter((section) =>
    !query ||
    section.label.toLowerCase().includes(query) ||
    section.keywords.some((keyword) => keyword.toLowerCase().includes(query)),
  );
  return (
    <div className="grid gap-[var(--space-1)]">
      <NavigationRailItem icon={IconChevronLeft} label="Back to workspaces" trailing={<HintKey size="compact">Esc</HintKey>} onClick={() => { setTreeFilter(null); setSettingsOpen(false); }} />
      <SettingsSearch
          inputRef={filterRef}
          value={treeFilter ?? ""}
          onChange={(e) => setTreeFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (treeFilter) {
                e.preventDefault();
                e.stopPropagation();
                setTreeFilter(null);
                filterRef.current?.blur();
              }
            }
          }}
        />
      <SettingsNavigation>
        {query ? <SettingsTreeSearch rows={rowHits} sections={sections} onDone={() => setTreeFilter(null)} /> : <SettingsTreeGroups sections={sections} active={activeSettingsSection} attention={attention} />}

      </SettingsNavigation>
    </div>
  );
}

function SettingsTreeSearch({ rows, sections, onDone }: { rows: ReturnType<typeof searchSettingsRows>; sections: readonly SettingsSectionDef[]; onDone: () => void }): React.JSX.Element {
  if (rows.length) return <>{rows.map(({ section, title }) => <SettingsRailRow key={`${section.id}:${title}`} kind="search" icon={SETTINGS_ICON_MAP[section.icon] ?? IconInfo} label={title} subtitle={section.label} sectionId={section.id} rowTitle={title} onClick={() => { requestSettingsRowJump(section.id, title); setSettingsSection(section.id); onDone(); }} />)}</>;
  if (sections.length) return <>{sections.map((section) => <SettingsRailRow key={section.id} kind="search" icon={SETTINGS_ICON_MAP[section.icon] ?? IconInfo} label={section.label} subtitle={section.group === 'agents' ? 'Agents' : 'Settings'} sectionId={section.id} onClick={() => { setSettingsSection(section.id); onDone(); }} />)}</>;
  return <EmptyListMessage kind="settings">No settings match your search.</EmptyListMessage>;
}

function SettingsTreeGroups({ sections, active, attention }: { sections: readonly SettingsSectionDef[]; active: string; attention?: AgentAttention }): React.JSX.Element {
  return <>{(['agents', 'app', 'work', 'devices', 'system'] as const).map((group) => <SettingsNavigationGroup key={group} label={group === 'agents' ? 'Agents' : group[0].toUpperCase() + group.slice(1)}>{sections.filter((section) => section.group === group).map((section) => <SettingsTreeSection key={section.id} section={section} active={active} attention={attention} />)}</SettingsNavigationGroup>)}</>;
}

function SettingsTreeSection({ section, active, attention }: { section: SettingsSectionDef; active: string; attention?: AgentAttention }): React.JSX.Element {
  const count = section.id === 'agents-overview' ? attention?.total ?? 0 : attention?.counts[section.id as keyof AgentAttention['counts']] ?? 0;
  return <SettingsRailRow kind="section" icon={SETTINGS_ICON_MAP[section.icon] ?? IconInfo} label={section.label} selected={active === section.id} sectionId={section.id} trailing={count > 0 ? <Count value={count} from={section.id === 'agents-mcp' ? 'stop' : 'warn'} /> : undefined} onClick={() => setSettingsSection(section.id)} />;
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

function RailTree({
  treeLabel,
  activeFilterCount,
  onSshConnect,
  onAddWorkspace,
  selected,
  filteredWorkspaces,
  workspaces,
  pinnedWorkspaces,
  sessions,
  colorOf,
  gridsByWorkspace,
  activeTagIds,
  tagById,
  dragPath,
  isWsOpen,
  dragActiveRef,
  startWsDrag,
  onSelect,
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
  onToggleGridUnread,
  isGridUnread,
}: {
  treeLabel: string;
  activeFilterCount: number;
  onSshConnect: () => void;
  onAddWorkspace: () => void;
  selected: string;
  filteredWorkspaces: Workspace[];
  workspaces: Workspace[];
  pinnedWorkspaces: ReadonlySet<string>;
  sessions: SessionInfo[];
  colorOf: (path: string) => string;
  gridsByWorkspace: Record<string, GridItem[]>;
  activeTagIds: number[];
  tagById: ReadonlyMap<number, TagInfo>;
  dragPath: string | null;
  isWsOpen: (path: string) => boolean;
  dragActiveRef: React.RefObject<boolean>;
  startWsDrag: (e: React.PointerEvent, path: string) => void;
  onSelect: (path: string) => void;
  toggleWsOpen: (path: string) => void;
  openMenu: (e: React.MouseEvent, w: Workspace, color: string) => void;
  onNewWorkspaceSession?: (path: string) => void;
  selectedGridId: string | null;
  gridRenaming: { path: string; gridId: string } | null;
  onRenameGrid?: (path: string, gridId: string, name: string) => void;
  onRemoveGrid?: (path: string, gridId: string) => void;
  onSelectGrid?: (path: string, gridId: string) => void;
  onFocusPane?: (paneId: number) => void;
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
  gridDragRefused: string | null;
  onToggleGridUnread: (gridId: string, signature: string, unread: boolean) => void;
  isGridUnread: (gridId: string, agents: ReturnType<typeof buildRailCard>['agents']) => { unread: boolean; signature: string };
  onOpenInspector?: (paneId: number, tab: "changes" | "pull-request") => void;
}): React.JSX.Element {
  const [expandedGrids, setExpandedGrids] = useState<ReadonlySet<string>>(() => new Set());
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
  // A workspace that never ran a session owns one empty, auto-named grid; listing it reads as the app creating grids.
  const isPlaceholderGrid = (path: string, grid: GridItem): boolean =>
    (gridsByWorkspace[path]?.length ?? 0) === 1 &&
    (grid.sessionIds?.length ?? 0) === 0 &&
    isAutoNameable({ id: grid.id, name: grid.name }) &&
    !(selected === path && selectedGridId === grid.id);
  const flatCards = useMemo(
    () => filteredWorkspaces.flatMap((workspace) => (gridsByWorkspace[workspace.path] ?? [])
      .filter((grid) => !isPlaceholderGrid(workspace.path, grid))
      .filter((grid) => !hiddenByTagFilter(grid, activeTagIds))
      .map((grid) => {
        const paneIds = grid.sessionIds ?? []
        const card = buildRailCard({
          gridId: grid.id,
          workspace: workspace.path,
          title: grid.name,
          pinned: pinnedGridIds.has(gridStorageKey(workspace.path, grid.id)),
          paneIds,
          sessions,
          branches: checkoutBranches,
          diffByDir: railDiffByDir,
          prByDir: railPrByDir,
        })
        return { workspace, grid, paneIds, card }
      })
      .filter(({ card }) => !railPrefs.filters.hideIdle || !['idle', 'done'].includes(card.status.kind))
      .filter(({ paneIds }) => !railPrefs.filters.hideEmptyGrids || paneIds.length > 0)
      .filter(({ card }) => !railPrefs.filters.hideDefaultBranch || !card.checkouts.some(
        (checkout) => 'branch' in checkout && ['main', 'master'].includes(checkout.branch ?? ''),
      ))),
    [
      filteredWorkspaces,
      gridsByWorkspace,
      activeTagIds,
      sessions,
      pinnedGridIds,
      checkoutBranches,
      railDiffByDir,
      railPrByDir,
      railPrefs.filters,
      selected,
      selectedGridId,
    ],
  )
  const cardKey = (entry: { workspace: Workspace; grid: GridItem }): string => gridStorageKey(entry.workspace.path, entry.grid.id);
  const [settledSmartCards, setSettledSmartCards] = useState(flatCards);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledSmartCards(flatCards), railPrefs.sort === 'smart' ? 3000 : 0);
    return () => window.clearTimeout(timer);
  }, [flatCards, railPrefs.sort]);
  const smartRank = (card: ReturnType<typeof buildRailCard>): number =>
    card.status.kind === 'needs-input' ? 0 :
      card.status.kind === 'working' ? 1 :
        card.agents.some((agent) => agent.unread) ? 2 : 3
  const settledStatusById = new Map(settledSmartCards.map((entry) => [cardKey(entry), entry.card]));
  const sortCards = (cards: typeof flatCards): typeof flatCards => {
    if (railPrefs.sort === 'name') return [...cards].sort((a, b) => a.grid.name.localeCompare(b.grid.name));
    if (railPrefs.sort === 'recent') return [...cards].sort((a, b) => b.card.lastActivityMs - a.card.lastActivityMs);
    if (railPrefs.sort === 'smart') return [...cards].sort((a, b) => {
      const left = settledStatusById.get(cardKey(a)) ?? a.card;
      const right = settledStatusById.get(cardKey(b)) ?? b.card;
      return smartRank(left) - smartRank(right) || right.lastActivityMs - left.lastActivityMs;
    });
    const order = new Map(railPrefs.gridOrder.map((id, index) => [id, index]));
    return [...cards].sort((left, right) =>
      (order.get(cardKey(left)) ?? Number.MAX_SAFE_INTEGER) - (order.get(cardKey(right)) ?? Number.MAX_SAFE_INTEGER),
    )
  };
  const pinnedCards = sortCards(flatCards.filter(({ card }) => card.pinned));
  const unpinnedCards = sortCards(flatCards.filter(({ card }) => !card.pinned));
  const groupingKey = (entry: typeof flatCards[number]): string => {
    const card = railPrefs.sort === 'smart'
      ? settledStatusById.get(cardKey(entry)) ?? entry.card
      : entry.card
    if (railPrefs.groupBy === 'status') {
      return card.status.kind === 'needs-input' ? 'Needs you' :
        card.status.kind === 'working' || card.status.kind === 'starting' ? 'Working' :
          card.status.kind === 'done' ? 'Done' : 'Idle'
    }
    if (railPrefs.groupBy === 'pr') return entry.card.pr?.pr ? 'Pull requests' : 'No pull request';
    return entry.workspace.name;
  };
  const unpinnedGroups = new Map<string, typeof unpinnedCards>();
  for (const entry of unpinnedCards) {
    const key = railPrefs.groupBy === 'none' ? '' : groupingKey(entry);
    unpinnedGroups.set(key, [...(unpinnedGroups.get(key) ?? []), entry]);
  }
  const groupEntries = [...unpinnedGroups.entries()].sort(([left], [right]) => {
    if (railPrefs.groupBy === 'status') {
      return ['Needs you', 'Working', 'Done', 'Idle'].indexOf(left) - ['Needs you', 'Working', 'Done', 'Idle'].indexOf(right)
    }
    if (railPrefs.groupBy === 'pr') {
      return ['Pull requests', 'No pull request'].indexOf(left) - ['Pull requests', 'No pull request'].indexOf(right)
    }
    return filteredWorkspaces.findIndex((workspace) => workspace.name === left) -
      filteredWorkspaces.findIndex((workspace) => workspace.name === right)
  });
  const renderFlatCard = ({ workspace, grid, paneIds, card }: typeof flatCards[number]): React.JSX.Element => {
    const selectedCard = selected === workspace.path && selectedGridId === grid.id;
    const onRemove = onRemoveGrid
      ? () => onRemoveGrid(workspace.path, grid.id)
      : undefined
    const key = gridStorageKey(workspace.path, grid.id);
    const jumpNumber = flatCards.findIndex((entry) => cardKey(entry) === key) + 1;
    const unreadState = isGridUnread(key, card.agents);
    if (gridRenaming?.path === workspace.path && gridRenaming.gridId === grid.id && onRenameGrid) {
      return (
        <WorkspaceTreeRow key={key} kind="child" data-testid="grid-row-renaming">
          <Icon glyph={IconGrid} role="ui" opacity="muted" />
          <RenameInput
            initial={grid.name}
            onSubmit={(name) => {
              setGridRenaming(null);
              const next = name.trim();
              if (next && next !== grid.name) onRenameGrid(workspace.path, grid.id, next);
            }}
            onCancel={() => setGridRenaming(null)}
          />
        </WorkspaceTreeRow>
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
          dragRefusal={gridDragRefused === key}
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
          onOpenInspector={(paneId, tab) => onOpenInspector?.(paneId, tab)}
        />
      </Suspense>
    )
  };
  const virtualItems: RailVirtualItem[] = [];
  const toggleGroup = (group: string): void => onRailPrefsChange({
    ...railPrefs,
    collapsedGroups: railPrefs.collapsedGroups.includes(group)
      ? railPrefs.collapsedGroups.filter((entry) => entry !== group)
      : [...railPrefs.collapsedGroups, group],
  })
  const groupHeader = (label: string, count: number, workspace?: Workspace, index = 0): React.JSX.Element => {
    if (workspace) {
      const collapsed = !isWsOpen(workspace.path);
      return (
        <WorkspaceRailGroupRow
          workspace={workspace}
          index={index}
          color={colorOf(workspace.path)}
          count={count}
          hasGrids={(gridsByWorkspace[workspace.path] ?? []).some((grid) => !isPlaceholderGrid(workspace.path, grid))}
          collapsed={collapsed}
          selected={selected === workspace.path}
          pinned={pinnedWorkspaces.has(workspace.path)}
          dragging={dragPath !== null}
          dragged={dragPath === workspace.path}
          renaming={renaming === workspace.path}
          dragActiveRef={dragActiveRef}
          startWsDrag={startWsDrag}
          onSelect={onSelect}
          onToggle={toggleWsOpen}
          onOpenMenu={openMenu}
          onNewSession={onNewWorkspaceSession}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
        />
      );
    }
    return (
      <RailGroupHeader>
        <RailGroupToggle
          aria-expanded={!railPrefs.collapsedGroups.includes(label)}
          onClick={() => toggleGroup(label)}
        >
          {label === 'Pinned' ? <Icon glyph={IconPin} role="small" tone="faint" className="flex-none" />
            : railPrefs.groupBy === 'status' ? <RailGroupStatusDot label={label} />
              : <Icon glyph={IconGitPullRequest} role="small" tone="faint" className="flex-none" />}
          <span className="truncate">{label}</span>
          {count > 0 && <RailGroupCount>{count}</RailGroupCount>}
        </RailGroupToggle>
      </RailGroupHeader>
    );
  };
  if (pinnedCards.length > 0) {
    virtualItems.push({
      key: 'group:pinned',
      kind: 'group',
      content: groupHeader('Pinned', pinnedCards.length),
    })
    if (!railPrefs.collapsedGroups.includes('Pinned')) {
      pinnedCards.forEach((entry) => virtualItems.push({
        key: `card:${cardKey(entry)}`,
        kind: 'card',
        content: renderFlatCard(entry),
      }))
    }
  }
  const workspaceGroups = railPrefs.groupBy === 'workspace'
    ? filteredWorkspaces
      // A workspace whose grids are all pinned is represented by the Pinned group alone.
      .filter((workspace) => !(gridsByWorkspace[workspace.path] ?? []).length || (gridsByWorkspace[workspace.path] ?? []).some((grid) => !pinnedGridIds.has(gridStorageKey(workspace.path, grid.id))))
      .map((workspace) => [workspace.name, unpinnedCards.filter((entry) => entry.workspace.path === workspace.path), workspace] as const)
    : groupEntries.map(([label, cards]) => [label, cards, undefined] as const)
  for (const [label, cards, workspace] of workspaceGroups) {
    if (label) virtualItems.push({
      key: `group:${workspace?.path ?? label}`,
      kind: 'group',
      content: groupHeader(label, cards.length, workspace, workspace ? filteredWorkspaces.findIndex((entry) => entry.path === workspace.path) : 0),
    })
    if (workspace ? isWsOpen(workspace.path) : !railPrefs.collapsedGroups.includes(label)) {
      cards.forEach((entry) => virtualItems.push({
        key: `card:${cardKey(entry)}`,
        kind: 'card',
        content: renderFlatCard(entry),
      }))
    }
  }
  if (virtualItems.length === 0) {
    virtualItems.push({
      key: 'empty',
      kind: 'group',
      content: (
        <EmptyListMessage>
          {activeTagIds.length > 0
            ? `No tab carries ${activeTagIds.length === 1 ? 'that tag' : 'any of those tags'}. Clear the filter in Sidebar options.`
            : workspaces.length === 0 ? 'No workspaces yet.' : 'No grids match these filters.'}
        </EmptyListMessage>
      ),
    })
  }
  return (
    <NavigationRailSection data-testid="rail-tree">
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
            ref={optionsTriggerRef}
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
        <Tooltip label="Add workspace">
          <span><AddWorkspaceMenu onAddWorkspace={onAddWorkspace} onSshConnect={onSshConnect} /></span>
        </Tooltip>
        <Tooltip label="New grid">
          <Button
            type="button"
            variant="compact-icon"
            aria-label="New grid"
            disabled={!onAddGrid}
            onClick={() => onAddGrid?.(selected)}
          >
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

      <RailActiveTagFilter tags={activeTagIds.flatMap((id) => tagById.get(id) ?? [])} onClear={onClearTagFilter} />
      <RailVirtualList items={virtualItems} compact={railPrefs.cardMode === 'compact'} dragging={dragPath !== null} />
    </NavigationRailSection>
  );
}

export function Sidebar({
  mascotFirstRun = false,
  mascotWorkspacesEmpty,
  workspaces,
  sessions,
  selected,
  customColors,
  colorIndexByPath,
  renaming,
  onSelect,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameStart,
  onOpenExternalError,
  onRenameSubmit,
  onRenameCancel,
  onReorderWorkspace,
  pinnedWorkspaces,
  onTogglePinWorkspace,
  onSshConnect,
  railClient,
  checkoutBranches = new Map(),
  onOpenInspector,
  gridsByWorkspace = {},
  onSelectGrid,
  onFocusPane,
  selectedGridId = null,
  onNewWorkspaceSession,
  onAddGrid,
  onRenameGrid,
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
  useEffect(() => {
    const timer = window.setTimeout(() => void preloadRailOptionsMenu(), 0);
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
    const prefs = migrateRailPrefs();
    if (prefs.properties.includes('tags') || loadTagFilter().length === 0) return prefs;
    return { ...prefs, properties: [...prefs.properties, 'tags'], customisedProperties: true };
  });
  const [gridDragId, setGridDragId] = useState<string | null>(null);
  const [gridDrop, setGridDrop] = useState<{ gridId: string; position: 'before' | 'after' } | null>(null);
  const [gridDragRefused, setGridDragRefused] = useState<string | null>(null);
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
    })))
    return {
      unread: isRailGridUnread(railPrefs.gridUnreadOverrides, gridId, signature, agents.some((agent) => agent.unread)),
      signature,
    }
  };
  const onToggleGridUnread = (gridId: string, signature: string, unread: boolean): void => {
    setRailPrefs((current) => {
      const gridUnreadOverrides = toggleRailGridRead(current.gridUnreadOverrides, gridId, signature, unread);
      return { ...current, gridUnreadOverrides };
    });
  };

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
  }, [gridsByWorkspace, sessions]);
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
            workspaceCarriesTag(
              w.path,
              gridsByWorkspace[w.path],
              sessions,
              activeTagIds,
            ),
          ),
    [workspaces, gridsByWorkspace, sessions, activeTagIds],
  );
  const pinnedCount = filteredWorkspaces.filter((w) =>
    pinnedWorkspaces.has(w.path),
  ).length;

  const [wsCollapsed, setWsCollapsed] = useState<Set<string>>(() =>
    loadCollapsedWorkspaces(),
  );
  const isWsOpen = (path: string): boolean => !wsCollapsed.has(path);
  const toggleWsOpen = (path: string): void => {
    setWsCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveCollapsedWorkspaces(next);
      return next;
    });
  };

  const [dragPath, setDragPath] = useState<string | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const dragActiveRef = useRef(false);

  const startWsDrag = (e: React.PointerEvent, path: string): void => {
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    const isPinnedDrag = pinnedWorkspaces.has(path);
    const clampToGroup = (idx: number): number =>
      isPinnedDrag
        ? Math.min(idx, pinnedCount)
        : Math.max(idx, pinnedCount);
    const setDrop = (idx: number | null): void => {
      dropIndexRef.current = idx;
    };
    const move = (ev: PointerEvent): void => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        active = true;
        dragActiveRef.current = true;
        setDragPath(path);
      }
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const rowEl = el?.closest("[data-ws-idx]") as HTMLElement | null;
      if (!rowEl) {
        const wlist = (el as HTMLElement | null)?.closest(".wlist");
        const rows = wlist?.querySelectorAll("[data-ws-idx]");
        const lastRow =
          rows && rows.length > 0
            ? (rows[rows.length - 1] as HTMLElement)
            : null;
        if (
          wlist &&
          lastRow &&
          ev.clientY > lastRow.getBoundingClientRect().bottom
        ) {
          setDrop(clampToGroup(filteredWorkspaces.length));
        } else {
          setDrop(null);
        }
        return;
      }
      const idx = Number(rowEl.getAttribute("data-ws-idx"));
      const rect = rowEl.getBoundingClientRect();
      setDrop(
        clampToGroup(ev.clientY < rect.top + rect.height / 2 ? idx : idx + 1),
      );
    };
    const cleanup = (commit: boolean): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (commit && active && dropIndexRef.current !== null) {
        onReorderWorkspace(
          path,
          translateFilteredDropIndex(
            workspaces,
            filteredWorkspaces,
            pinnedWorkspaces,
            path,
            dropIndexRef.current,
          ),
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
    if (railPrefs.sort !== 'manual' || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let target: { gridId: string; position: 'before' | 'after'; workspace: string } | null = null;
    const move = (pointer: PointerEvent): void => {
      if (!active) {
        if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 5) return;
        active = true;
        setGridDragId(gridStorageKey(workspace, gridId));
      }
      const row = document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest('[data-rail-grid-id]') as HTMLElement | null;
      if (!row) { target = null; setGridDrop(null); setGridDragRefused(null); return; }
      const targetId = row.dataset.railGridId;
      const targetWorkspace = row.dataset.railWorkspace;
      const sourceKey = gridStorageKey(workspace, gridId);
      const targetKey = targetId && targetWorkspace ? gridStorageKey(targetWorkspace, targetId) : '';
      if (!targetId || !targetWorkspace || targetKey === sourceKey) { target = null; setGridDrop(null); setGridDragRefused(null); return; }
      if (!canReorderRailGrid(railPrefs.sort, workspace, targetWorkspace)) {
        target = null
        setGridDrop(null)
        setGridDragRefused(targetKey)
        return
      }
      const rect = row.getBoundingClientRect();
      const position = pointer.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      target = { gridId: targetKey, position, workspace: targetWorkspace };
      setGridDrop({ gridId: targetKey, position });
      setGridDragRefused(null);
    };
    const cleanup = (commit: boolean): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      const sourceKey = gridStorageKey(workspace, gridId);
      if (commit && active && target?.workspace === workspace && target.gridId !== sourceKey) {
        const order = [...new Set([...railPrefs.gridOrder, ...allGridKeys(gridsByWorkspace)])];
        const next = reorderRailGrid(order, sourceKey, target.gridId, target.position === 'before');
        setRailPrefs((current) => ({ ...current, gridOrder: next }));
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

  useEffect(() => {
    if (!menu && !gridMenu && !navMenu) return;
    const closeAll = (): void => {
      setMenu(null);
      setGridMenu(null);
      setNavMenu(null);
    };
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (
        !target.closest(".ctxmenu") &&
        !target.closest('[data-testid="tag-popover"]') &&
        !target.closest('[data-testid="rail-options-trigger"]')
      )
        closeAll();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeAll();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu, gridMenu, navMenu]);

  const openMenu = (e: React.MouseEvent, w: Workspace, color: string): void => {
    e.preventDefault();
    setGridMenu(null);
    const x = Math.min(e.clientX, window.innerWidth - 244);
    const y = Math.min(e.clientY, window.innerHeight - 170);
    setMenu({
      x,
      y,
      originX: e.clientX - x,
      originY: e.clientY - y,
      path: w.path,
      name: w.name,
      color,
      pinned: pinnedWorkspaces.has(w.path),
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
    const x = e.clientX;
    const y = e.clientY;
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
      pinned: pinnedGridIds.has(gridStorageKey(path, grid.id)),
      tagIds: grid.tagIds ?? [],
      tagNames: tags.filter((tag) => grid.tagIds?.includes(tag.id)).map((tag) => tag.name),
      agentCount: gridAgentCount(grid),
      ...railGridContextFacts(grid, path, sessions, checkoutBranches, railPrByDir),
    });
  };

  const toggleGridPin = (path: string, gridId: string): void => setPinnedGridIds((current) => {
    const key = gridStorageKey(path, gridId)
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  });

  useEffect(() => {
    localStorage.setItem(TAG_FILTER_KEY, JSON.stringify(activeTagIds));
  }, [activeTagIds]);
  const activeFilterCount = activeTagIds.length +
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
      menu={menu}
      onClose={() => setMenu(null)}
      onAddGrid={onAddGrid}
      onRenameStart={onRenameStart}
      onRemoveWorkspace={onRemoveWorkspace}
      onOpenExternalError={onOpenExternalError}
      onTogglePin={onTogglePinWorkspace}
    />
  );

  const { removeGrid, closingLastEl } = useGridCloseConfirm(gridsByWorkspace, onRemoveGrid);

  const gridMenuEl = gridMenu && (
    <GridContextMenu
      gridMenu={gridMenu}
      onClose={() => setGridMenu(null)}
      onOpenGrid={onSelectGrid}
      onStartRename={(path, gridId) => setGridRenaming({ path, gridId })}
      onRemoveGrid={removeGrid}
      onTogglePin={toggleGridPin}
      onOpenInspector={onOpenInspector}
      onError={onOpenExternalError}
    />
  );

  const navMenuEl = (
    <NavViewMenu
      navMenu={navMenu}
      onClose={() => setNavMenu(null)}
      onHide={(v) => setRailViewHidden(v, true)}
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
        onFilter: (tagIds) => {
          setTagFilter(tagIds);
          setRailPrefs((current) => ({ ...current, tags: tagIds }));
        },
      }}
    >
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
            railPrefs={railPrefs}
            pinnedGridIds={pinnedGridIds}
            onRailPrefsChange={(next) => setRailPrefs(next)}
            onFilterTag={(tag) => {
              setTagFilter([tag.id]);
              setRailPrefs((current) => ({ ...current, tags: [tag.id] }));
            }}
            onClearTagFilter={() => setTagFilter([])}
            railOptionsAnchor={railOptionsAnchor}
            setRailOptionsAnchor={setRailOptionsAnchor}
            suppressGridClickRef={suppressGridClickRef}
            gridDragId={gridDragId}
            gridDrop={gridDrop}
            gridDragRefused={gridDragRefused}
            onGridPointerDown={startGridDrag}
            onToggleGridUnread={onToggleGridUnread}
            isGridUnread={isGridUnread}
            onAddWorkspace={onAddWorkspace}
            selected={selected}
            filteredWorkspaces={filteredWorkspaces}
            workspaces={workspaces}
            pinnedWorkspaces={pinnedWorkspaces}
            sessions={sessions}
            colorOf={colorOf}
            gridsByWorkspace={gridsByWorkspace}
            activeTagIds={activeTagIds}
            tagById={tagById}
            dragPath={dragPath}
            isWsOpen={isWsOpen}
            dragActiveRef={dragActiveRef}
            startWsDrag={startWsDrag}
            onSelect={onSelect}
            toggleWsOpen={toggleWsOpen}
            openMenu={openMenu}
            onNewWorkspaceSession={onNewWorkspaceSession}
            selectedGridId={selectedGridId}
            gridRenaming={gridRenaming}
            onRenameGrid={onRenameGrid}
            onRemoveGrid={removeGrid}
            onSelectGrid={onSelectGrid}
            onFocusPane={onFocusPane}
            openGridMenu={openGridMenu}
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
        <Tooltip label={chromeTheme === "paper" ? "Switch to dark theme" : "Switch to light theme"}>
          <Button
            variant="subtle-icon"
            aria-label={chromeTheme === "paper" ? "Switch to dark theme" : "Switch to light theme"}
            onClick={(event) => onToggleChromeTheme(event.currentTarget)}
          >
            <Icon glyph={chromeTheme === "paper" ? IconSun : IconMoon} role="ui" />
          </Button>
        </Tooltip>
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
