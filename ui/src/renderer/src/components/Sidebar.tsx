import { useSessionsSelector, shallowArrayEqual } from '../sessionsStore';
import type { TagInfo } from "../houston/generated/TagInfo";
import { MAX_TAGS_PER_GRID } from "../layout/tree";
import type { TagUsage } from "./TagManager";
import type { TagEditorState } from "./tagEditing";
import {
  Fragment,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { HoustonClient, PrInfo, SessionInfo, Workspace } from "../houston/client";
import { isLive } from "../houston/client";
import { useRailWidth } from "../railWidth";
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
  IconArrowUp,
  IconChevronRight,
  IconCheck,
  IconClose,
  IconCodeXml,
  IconDatabase,
  IconEyeOff,
  IconFilter,
  IconFolder,
  IconGear,
  IconGitFork,
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
  IconServer,
  IconUser,
  IconTarget,
  IconTasks,
  IconFolderOpen,
  IconChartArea,
  IconTerminal,
  IconZap,
  IconGlobe,
  IconClock,
  type IconProps,
} from "./icons";
import { Tooltip } from "./ui/Tooltip";
import logoUrl from "../assets/logo-chrome.svg";
import { openExternal, showItemInFolder } from "../houston/bridge";
import { OpenInMenu } from "./OpenInMenu";
import { Icon } from "./ui/Icon";
import { Count } from "./ui/Count";
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
import { TreeGroupHeader } from "./ui/TreeGroupHeader";
import { HorizontalRule, WorkspaceGroupDivider, WorkspaceGroupLabel } from "./ui/WorkspaceGroupLabel";
import { NavigationRailFooter, NavigationRailScroll, WorkspaceList, SettingsNavigation } from "./ui/NavigationRailFooter";
import { NavigationRail, NavigationRailHeader, NavigationRailSection, NavigationRailItem, NavigationRailSearch, RailSurface } from "./ui/NavigationRail";
import { openUpdateModal } from "../updateModal";
import { isUpdateInstallRunning, useUpdateInstall, type UpdateInstallState } from "../updateInstall";
import { useRailGitCache } from "./git/railGitCache";
import { useRailPrCache } from "./git/railPrCache";
import type { RailDiffTotals } from "./git/useRailGitFacts";
import type { RailPrState } from "./git/railPrCache";
import { GridRailRowFallback } from "./ui/GridRailRowFallback";
import { SettingsRailRow } from "./ui/SettingsRailRow";
import { SettingsSearch } from "./ui/SettingsSearch";
import { ContextMenu, ContextMenuItem, ContextMenuColorDot, ContextMenuHeading, ContextMenuItems, ContextMenuMessage, ContextMenuSectionLabel, ContextMenuSeparator } from "./ui/ContextMenu";
import { WorkspaceTreeRow, WorkspaceTreeLabel, WorkspaceTreeActions, WorkspaceTreeAuxButton, WorkspaceDropIndicator, EmptyListMessage } from "./ui/WorkspaceTreeRow";
import { TextInput } from "./ui/TextInput";
import { ActivityDot } from "./ui/ActivityDot";
import { Text } from "./ui/Text";

const SETTINGS_ICON_MAP: Record<string, (p: IconProps) => React.JSX.Element> = {
  palette: IconPalette,
  terminal: IconTerminal,
  keyboard: IconKeyboard,
  user: IconUser,
  bell: IconInfo,
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
};

const GridRailContextActions = lazy(() => import("./ui/GridRailContextActions").then((module) => ({ default: module.GridRailContextActions })));
const GridRailGitSubscription = lazy(() => import("./git/GridRailGitSubscription").then((module) => ({ default: module.GridRailGitSubscription })));
const LazyGridRailRow = lazy(() => import("./ui/GridRailRow").then((module) => ({ default: module.GridRailRow })));

export function railUpdateChip(
  version: string | null | undefined,
  install: UpdateInstallState,
): { label: string; tooltip: string; failed: boolean } | null {
  if (isUpdateInstallRunning(install)) {
    const pct =
      install.kind === "downloading" && install.total !== null && install.total > 0
        ? Math.min(100, Math.floor((install.downloaded / install.total) * 100))
        : null;
    return {
      label: pct === null ? "Updating…" : `Updating ${pct}%`,
      tooltip: "Houston is installing an update. Open to see the steps",
      failed: false,
    };
  }
  if (install.kind === "failed") {
    return {
      label: "Update failed",
      tooltip: `Houston ${install.version} did not install. Open to see why and try again`,
      failed: true,
    };
  }
  if (version == null) return null;
  return {
    label: `${version} available`,
    tooltip: `Houston v${version} is available. Open to install`,
    failed: false,
  };
}

// Its own component so the foot keeps no branch of its own: nothing at all is
// rendered until a release is waiting or an install is running or has failed.
function RailUpdateButton({ version }: { version?: string | null }): React.JSX.Element | null {
  const install = useUpdateInstall();
  const chip = railUpdateChip(version, install);
  if (chip === null) return null;
  return (
    <Tooltip label={chip.tooltip}>
      <Button
        variant="status-chip"
        status={chip.failed ? "failed" : "available"}
        data-testid="rail-update-available"
        aria-label={chip.tooltip}
        onClick={openUpdateModal}
      >
        <Icon glyph={chip.failed ? IconAlertTriangle : IconArrowUp} role="ui" />
        <span>{chip.label}</span>
      </Button>
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
  selectedGridId?: string | null;

  onAddGrid?: (path: string) => void;
  onNewWorkspaceSession?: (path: string) => void;
  onRenameGrid?: (path: string, gridId: string, name: string) => void;
  onRemoveGrid?: (path: string, gridId: string) => void;

  onOpenSettings?: () => void;
  onOpenPalette?: () => void;
  paletteChord?: string | null;
  onHideRail?: () => void;
  chromeTheme: ChromeTheme;
  onToggleChromeTheme: (origin: HTMLElement) => void;
  updateVersion?: string | null;
  harnessAttention?: number;
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
  tagIds: number[];
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
    branch: pane ? orValue(branches.get(pane.id), orValue(pane.worktree?.branch, null)) : null,
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

// Neither tag surface is on a launch path, so both load on first use — see
// bundle-budget.json's forbiddenBootPaths, which holds them there.
const TagEditor = lazy(() =>
  import("./tagEditing").then((m) => ({ default: m.TagEditor })),
);

function TagEditorSurface({
  state,
  tags,
  onSave,
  onCancel,
  onTagCreate,
  onTagUpdate,
}: {
  state: TagEditorState | null;
  tags: TagInfo[];
  onSave: (name: string, color: string, editing: TagInfo | null) => void;
  onCancel: () => void;
  onTagCreate?: (name: string, color: string) => void;
  onTagUpdate?: (tag: number, name: string, color: string) => void;
}): React.JSX.Element | null {
  if (!state || !onTagCreate || !onTagUpdate) return null;
  return (
    <Suspense fallback={null}>
      <TagEditor state={state} tags={tags} onSave={onSave} onCancel={onCancel} />
    </Suspense>
  );
}

const TagManager = lazy(() =>
  import("./TagManager").then((m) => ({ default: m.TagManager })),
);

function TagManagerSurface({
  open,
  tags,
  usage,
  highlight,
  onClose,
  onTagCreate,
  onTagUpdate,
  onTagDelete,
}: {
  open: boolean;
  tags: TagInfo[];
  usage: Map<number, TagUsage>;
  highlight: string | null;
  onClose: () => void;
  onTagCreate?: (name: string, color: string) => void;
  onTagUpdate?: (tag: number, name: string, color: string) => void;
  onTagDelete?: (tag: number) => void;
}): React.JSX.Element | null {
  if (!open || !onTagCreate || !onTagUpdate || !onTagDelete) return null;
  return (
    <Suspense fallback={null}>
      <TagManager
        open={open}
        tags={tags}
        usage={usage}
        highlight={highlight}
        onCreate={onTagCreate}
        onUpdate={onTagUpdate}
        onDelete={onTagDelete}
        onClose={onClose}
      />
    </Suspense>
  );
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
  workspaces,
  tags,
  onClose,
  onStartRename,
  onRemoveGrid,
  onToggleTag,
  onFilterByTags,
  onNewTag,
  onManageTags,
  onOpenInspector,
  onError,
}: {
  gridMenu: GridCtxMenu;
  workspaces: Workspace[];
  tags: TagInfo[];
  onClose: () => void;
  onStartRename: (path: string, gridId: string) => void;
  onRemoveGrid?: (path: string, gridId: string) => void;
  onToggleTag: (menu: GridCtxMenu, tagId: number) => void;
  onFilterByTags: (tagIds: number[]) => void;
  onNewTag: (e: React.MouseEvent) => void;
  onManageTags: () => void;
  onOpenInspector?: (paneId: number, tab: "pull-request") => void;
  onError?: (message: string) => void;
}): React.JSX.Element {
  const workspaceName =
    workspaces.find((w) => w.path === gridMenu.path)?.name ?? gridMenu.path;
  return (
    <ContextMenu
      className=""
      style={{
        top: gridMenu.y,
        left: gridMenu.x,
        ["--pop-origin-x" as string]: `${gridMenu.originX}px`,
        ["--pop-origin-y" as string]: `${gridMenu.originY}px`,
      }}
      role="menu"
      onKeyDown={handleMenuKeyDown}
    >
      {ctxHeader(gridMenu.name, workspaceName)}
      <ContextMenuItems>
        <Suspense fallback={null}>
          <GridRailContextActions
            paneId={gridMenu.paneId}
            branch={gridMenu.branch}
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
        <ContextMenuItem

          role="menuitem"
          onClick={() => {
            onStartRename(gridMenu.path, gridMenu.gridId);
            onClose();
          }}
        >
          <Icon glyph={IconPencil} role="ui" />
          <span>Rename</span>
        </ContextMenuItem>
        {gridMenu.canRemove && (
          <ContextMenuItem danger

            role="menuitem"
            onClick={() => {
              const { path, gridId } = gridMenu;
              onClose();
              onRemoveGrid?.(path, gridId);
            }}
          >
            <Icon glyph={IconClose} role="ui" />
            <span>Close Tab</span>
          </ContextMenuItem>
        )}
        {tags.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSectionLabel>Tags</ContextMenuSectionLabel>
            {tags.map((t) => {
              const on = gridMenu.tagIds.includes(t.id);
              const capBlocked =
                !on && gridMenu.tagIds.length >= MAX_TAGS_PER_GRID;
              return (
                <ContextMenuItem
                  key={t.id}

                  role="menuitemcheckbox"
                  aria-checked={on}
                  disabled={capBlocked}
                  data-testid="menu-tag-item"
                  data-tag={t.id}
                  onClick={() => onToggleTag(gridMenu, t.id)}
                >
                  <ContextMenuColorDot color={t.color} />
                  <span className="truncate">{t.name}</span>
                  {on && (
                  <Text tone="accent">
                    <Icon glyph={IconCheck} role="label" />
                  </Text>
                  )}
                </ContextMenuItem>
              );
            })}
            {gridMenu.tagIds.length > 0 && (
              <ContextMenuItem

                role="menuitem"
                data-testid="menu-filter-by-tag"
                onClick={() => {
                  onFilterByTags(gridMenu.tagIds);
                  onClose();
                }}
              >
                <Icon glyph={IconFilter} role="ui" />
                <span>
                  {gridMenu.tagIds.length === 1
                    ? "Filter by this tag"
                    : `Filter by these ${gridMenu.tagIds.length} tags`}
                </span>
              </ContextMenuItem>
            )}
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem

          role="menuitem"
          data-testid="menu-new-tag"
          onClick={onNewTag}
        >
          <Icon glyph={IconPlus} role="ui" />
          <span>New tag…</span>
        </ContextMenuItem>
        {tags.length > 0 && (
          <ContextMenuItem

            role="menuitem"
            data-testid="menu-manage-tags"
            onClick={onManageTags}
          >
            <Icon glyph={IconGear} role="ui" />
            <span>Manage tags…</span>
          </ContextMenuItem>
        )}
      </ContextMenuItems>
    </ContextMenu>
  );
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

function PinIndicator(): React.JSX.Element {
  return (
    <Tooltip label="Pinned">
      <span aria-label="Pinned" data-testid="ws-pinned-indicator" className="flex-none flex items-center">
        <Icon glyph={IconPin} role="small" tone="muted" />
      </span>
    </Tooltip>
  );
}

function CollapsedGridsRow({
  w,
  i,
  color,
  renamingThis,
  onRenameSubmit,
  onRenameCancel,
  on,
  pinned,
  dragPath,
  dropBefore,
  dragActiveRef,
  startWsDrag,
  selected,
  onSelect,
  toggleWsOpen,
  openMenu,
}: {
  w: Workspace;
  i: number;
  color: string;
  on: boolean;
  pinned: boolean;
  dragPath: string | null;
  dropBefore: React.ReactNode;
  dragActiveRef: React.RefObject<boolean>;
  startWsDrag: (e: React.PointerEvent, path: string) => void;
  selected: string;
  onSelect: (path: string) => void;
  toggleWsOpen: (path: string) => void;
  openMenu: (e: React.MouseEvent, w: Workspace, color: string) => void;
  renamingThis: boolean;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
}): React.JSX.Element {
  if (renamingThis) {
    return (
      <Fragment>
        {dropBefore}
        <WorkspaceRenameField
          w={w}
          i={i}
          color={color}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
        />
      </Fragment>
    );
  }
  return (
    <Fragment>
      {dropBefore}
      <Tooltip label={w.path}>
        <WorkspaceTreeRow
          kind="tree"
          dragging={dragPath !== null}
          dragged={dragPath === w.path}
          role="button"
          tabIndex={0}
          aria-label={w.path}
          data-ws-idx={i}
          data-testid="ws-disclosure"
          aria-current={on ? "true" : undefined}
          aria-expanded={false}
          data-dragging={dragPath === w.path || undefined}
          onPointerDown={(e) => {
            dragActiveRef.current = false;
            if (e.button !== 0) return;
            startWsDrag(e, w.path);
          }}
          onClick={() => {
            if (dragActiveRef.current) {
              dragActiveRef.current = false;
              return;
            }
            if (selected !== w.path) onSelect(w.path);
            toggleWsOpen(w.path);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            if (selected !== w.path) onSelect(w.path);
            toggleWsOpen(w.path);
          }}
          onContextMenu={(e) => openMenu(e, w, color)}
        >
          <Button
            type="button"
            variant="disclosure-icon"
            aria-label={`Expand ${w.name}`}
            data-testid="ws-chevron"
            className="flex-none"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleWsOpen(w.path);
            }}
          >
            <Icon glyph={IconChevronRight} role="small" opacity="subtle" />
          </Button>
          <Icon glyph={IconFolder} role="ui" opacity="muted" />
          <WorkspaceTreeLabel>
            {w.name}
          </WorkspaceTreeLabel>
          <WorkspaceTreeActions>
            {pinned && <PinIndicator />}
          </WorkspaceTreeActions>
        </WorkspaceTreeRow>
      </Tooltip>
    </Fragment>
  );
}

type GridLifecycle =
  | "starting"
  | "working"
  | "needs-input"
  | "idle"
  | "unavailable"
  | "stopped";

function gridLifecycle(sessions: SessionInfo[]): {
  state: GridLifecycle;
  label: string;
} {
  const live = sessions.filter((session) => isLive(session.state));
  if (live.length === 0) return { state: "stopped", label: "No live panes" };

  const count = (status: SessionInfo["status"]): number =>
    live.filter((session) => session.status === status).length;
  const needsInput = live.filter((session) => session.status === "needs-input" || session.children_waiting > 0).length;
  const working = count("working");
  const starting = count("spawning");
  const idle = count("idle");
  const unavailable = count("unavailable") + count(null) + count(undefined);
  const state: GridLifecycle = needsInput
    ? "needs-input"
    : working
      ? "working"
      : starting
        ? "starting"
        : unavailable
          ? "unavailable"
          : "idle";
  const parts = [
    needsInput ? `${needsInput} need input` : "",
    working ? `${working} working` : "",
    starting ? `${starting} starting` : "",
    idle ? `${idle} ready` : "",
    unavailable ? `${unavailable} status unavailable` : "",
  ].filter(Boolean);
  return { state, label: parts.join(" · ") };
}

function GridStateDot({
  state: stateProp = "stopped",
  label: labelProp = "No live panes",
  sessionIds,
}: {
  state?: GridItem["state"];
  label?: string;
  sessionIds?: number[];
}): React.JSX.Element {
  const members = useSessionsSelector(
    (sessions) => (sessionIds ?? []).flatMap((id) => sessions.get(id) ?? []),
    (a, b) => a === b || (a !== null && b !== null && shallowArrayEqual(a, b)),
    null,
  );
  const lifecycle = members !== null && sessionIds !== undefined ? gridLifecycle(members) : null;
  const state = lifecycle?.state ?? stateProp;
  const label = lifecycle?.label ?? labelProp;
  const active = state === "starting" || state === "working";
  return <Tooltip label={label}><ActivityDot state={state} label={label} active={active} /></Tooltip>;
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

function filterLabelFor(activeTagCount: number): string {
  return activeTagCount > 0
    ? `Filter by tag (${activeTagCount} active)`
    : "Filter by tag";
}

function ExpandedGridsRow({
  w,
  i,
  color,
  renamingThis,
  onRenameSubmit,
  onRenameCancel,
  on,
  pinned,
  grids,
  activeTagIds,
  tagById,
  dragPath,
  dropBefore,
  dragActiveRef,
  startWsDrag,
  selected,
  onSelect,
  toggleWsOpen,
  openMenu,
  onNewWorkspaceSession,
  selectedGridId,
  gridRenaming,
  onRenameGrid,
  onRemoveGrid,
  onSelectGrid,
  openGridMenu,
  setGridRenaming,
  checkoutBranches,
  sessions,
  railDiffByDir,
  railPrByDir,
  railWidth,
  onOpenInspector,
}: {
  w: Workspace;
  i: number;
  color: string;
  on: boolean;
  pinned: boolean;
  grids: GridItem[];
  activeTagIds: number[];
  tagById: ReadonlyMap<number, TagInfo>;
  dragPath: string | null;
  dropBefore: React.ReactNode;
  dragActiveRef: React.RefObject<boolean>;
  startWsDrag: (e: React.PointerEvent, path: string) => void;
  selected: string;
  onSelect: (path: string) => void;
  toggleWsOpen: (path: string) => void;
  openMenu: (e: React.MouseEvent, w: Workspace, color: string) => void;
  onNewWorkspaceSession?: (path: string) => void;
  selectedGridId: string | null;
  gridRenaming: { path: string; gridId: string } | null;
  onRenameGrid?: (path: string, gridId: string, name: string) => void;
  onRemoveGrid?: (path: string, gridId: string) => void;
  onSelectGrid?: (path: string, gridId: string) => void;
  openGridMenu: (
    e: React.MouseEvent,
    path: string,
    grid: GridItem,
    canRemove: boolean,
  ) => void;
  checkoutBranches: ReadonlyMap<number, string>;
  sessions: SessionInfo[];
  railDiffByDir: ReadonlyMap<string, RailDiffTotals>;
  railPrByDir: ReadonlyMap<string, RailPrState>;
  railWidth: number;
  onOpenInspector?: (paneId: number, tab: "changes" | "pull-request") => void;
  setGridRenaming: (v: { path: string; gridId: string } | null) => void;
  renamingThis: boolean;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
}): React.JSX.Element {
  return (
    <Fragment>
      {dropBefore}
      {renamingThis ? (
        <WorkspaceRenameField
          w={w}
          i={i}
          color={color}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
        />
      ) : (
      <Tooltip label={w.path}>
        <WorkspaceTreeRow
          kind="tree"
          selected={on}
          dragging={dragPath !== null}
          dragged={dragPath === w.path}
          role="button"
          tabIndex={0}
          aria-label={w.path}
          data-ws-idx={i}
          data-testid="ws-disclosure"
          aria-current={on ? "true" : undefined}
          aria-expanded={true}
          data-dragging={dragPath === w.path || undefined}
          onPointerDown={(e) => {
            dragActiveRef.current = false;
            if (e.button !== 0) return;
            startWsDrag(e, w.path);
          }}
          onClick={() => {
            if (dragActiveRef.current) {
              dragActiveRef.current = false;
              return;
            }
            if (selected === w.path) toggleWsOpen(w.path);
            else onSelect(w.path);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            if (selected === w.path) toggleWsOpen(w.path);
            else onSelect(w.path);
          }}
          onContextMenu={(e) => openMenu(e, w, color)}
        >
          <Button
            type="button"
            variant="disclosure-icon"
            aria-label={`Collapse ${w.name}`}
            data-testid="ws-chevron"
            className="flex-none"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleWsOpen(w.path);
            }}
          >
            <Icon glyph={IconChevronRight} role="small" rotated />
          </Button>
          <Icon glyph={IconFolder} role="ui" opacity="muted" />
          <WorkspaceTreeLabel>
            {w.name}
          </WorkspaceTreeLabel>
          <WorkspaceTreeActions>
            {pinned && <PinIndicator />}
          </WorkspaceTreeActions>
          {onNewWorkspaceSession && (
            <Tooltip label="New session">
              <WorkspaceTreeAuxButton
                type="button"
                aria-label={`New session in ${w.name}`}
                data-testid="ws-new-session"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewWorkspaceSession(w.path);
                }}
              >
                <Icon glyph={IconPlus} role="small" />
              </WorkspaceTreeAuxButton>
            </Tooltip>
          )}
        </WorkspaceTreeRow>
      </Tooltip>
      )}
      {grids.map((g) => {
        if (hiddenByTagFilter(g, activeTagIds)) return null;
        const gridOn =
          selected === w.path && selectedGridId === g.id;
        const stateDot = (
          <GridStateDot
            sessionIds={g.sessionIds}
            state={g.state ?? undefined}
            label={g.statusLabel ?? undefined}
          />
        );
        if (
          gridRenaming?.path === w.path &&
          gridRenaming.gridId === g.id &&
          onRenameGrid
        ) {
          return (
            <WorkspaceTreeRow
              key={g.id}
              kind="child"
              data-testid="grid-row-renaming"
            >
              {stateDot}
              <Icon glyph={IconGrid} role="ui" opacity="muted" />
              <RenameInput
                initial={g.name}
                onSubmit={(name) => {
                  setGridRenaming(null);
                  const next = name.trim();
                  if (next && next !== g.name) onRenameGrid(w.path, g.id, next);
                }}
                onCancel={() => setGridRenaming(null)}
              />
            </WorkspaceTreeRow>
          );
        }
        const onRemove = onRemoveGrid && grids.length > 1 ? () => onRemoveGrid(w.path, g.id) : undefined;
        return <Suspense key={g.id} fallback={<GridRailRowFallback name={g.name} selected={gridOn} jumpNumber={grids.indexOf(g) + 1} onSelect={() => onSelectGrid?.(w.path, g.id)} onContextMenu={(event) => openGridMenu(event, w.path, g, Boolean(onRemoveGrid) && grids.length > 1)} onRemove={onRemove} />}><LazyGridRailRow
          key={g.id}
          name={g.name}
          selected={gridOn}
          paneIds={g.sessionIds ?? []}
          fallbackSessions={sessions}
          tags={(g.tagIds ?? []).flatMap((id) => tagById.get(id) ?? [])}
          branches={checkoutBranches}
          diffByDir={railDiffByDir}
          prByDir={railPrByDir}
          width={railWidth}
          jumpNumber={grids.indexOf(g) + 1}
          onSelect={() => onSelectGrid?.(w.path, g.id)}
          onRemove={onRemove}
          onContextMenu={(event) => openGridMenu(event, w.path, g, Boolean(onRemoveGrid) && grids.length > 1)}
          onOpenInspector={(paneId, tab) => onOpenInspector?.(paneId, tab)}
          onOpenExternal={(url) => { void openExternal(url); }}
        /></Suspense>;
      })}
    </Fragment>
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

function RenamingWorkspaceRow({
  w,
  i,
  color,
  dropBefore,
  onRenameSubmit,
  onRenameCancel,
}: {
  w: Workspace;
  i: number;
  color: string;
  dropBefore: React.ReactNode;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
}): React.JSX.Element {
  return (
    <Fragment>
      {dropBefore}
      <WorkspaceRenameField
        w={w}
        i={i}
        color={color}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
      />
    </Fragment>
  );
}

function PlainWorkspaceRow({
  w,
  i,
  color,
  on,
  pinned,
  dragPath,
  dropBefore,
  dragActiveRef,
  startWsDrag,
  onSelect,
  openMenu,
  onRemoveWorkspace,
}: {
  w: Workspace;
  i: number;
  color: string;
  on: boolean;
  pinned: boolean;
  dragPath: string | null;
  dropBefore: React.ReactNode;
  dragActiveRef: React.RefObject<boolean>;
  startWsDrag: (e: React.PointerEvent, path: string) => void;
  onSelect: (path: string) => void;
  openMenu: (e: React.MouseEvent, w: Workspace, color: string) => void;
  onRemoveWorkspace: (path: string) => void;
}): React.JSX.Element {
  return (
    <Fragment>
      {dropBefore}
      <Tooltip label={w.path}>
        <WorkspaceTreeRow
          kind="plain"
          selected={on}
          dragging={dragPath !== null}
          dragged={dragPath === w.path}
          role="button"
          tabIndex={0}
          aria-label={w.path}
          data-ws-idx={i}
          aria-current={on ? "true" : undefined}
          data-dragging={dragPath === w.path || undefined}
          onPointerDown={(e) => {
            dragActiveRef.current = false;
            if (e.button !== 0) return;
            startWsDrag(e, w.path);
          }}
          onClick={() => {
            if (dragActiveRef.current) {
              dragActiveRef.current = false;
              return;
            }
            onSelect(w.path);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onSelect(w.path);
          }}
          onContextMenu={(e) => openMenu(e, w, color)}
        >
          <Icon glyph={IconFolder} role="ui" opacity="muted" />
          <WorkspaceTreeLabel size="md">
            {w.name}
          </WorkspaceTreeLabel>
          <WorkspaceTreeActions>
            {pinned && <PinIndicator />}
            <Tooltip label="Close workspace (stops its agents)">
              <WorkspaceTreeAuxButton
                type="button"
                aria-label="Close workspace (stops its agents)"
                selected={on}
                style={on ? { color } : undefined}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveWorkspace(w.path);
                }}
              >
                <Icon glyph={IconClose} role="small" />
              </WorkspaceTreeAuxButton>
            </Tooltip>
          </WorkspaceTreeActions>
        </WorkspaceTreeRow>
      </Tooltip>
    </Fragment>
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
    projects: IconFolderOpen,
    tasks: IconTasks,
    skills: IconZap,
    routines: IconClock,
    harness: IconTarget,
    mcp: IconGlobe,
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
  harnessAttention,
}: {
  view: RailView | null;
  hidden: ReadonlySet<RailView>;
  paletteChord: string | null | undefined;
  taskTurnCount: number;
  onOpenPalette: (() => void) | undefined;
  onSelect: (v: RailView) => void;
  onRowMenu: (e: React.MouseEvent, v: RailView) => void;
  harnessAttention?: number;
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
            trailing={v === "harness" ? <Count value={harnessAttention ?? 0} from="accent" /> : v === "tasks" && taskTurnCount > 0 ? <Count value={taskTurnCount} from="accent" /> : null}
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

function TagFilterMenu({
  menu,
  tags,
  activeTagIds,
  onToggle,
  onClear,
}: {
  menu: { x: number; y: number; originX: number; originY: number } | null;
  tags: TagInfo[];
  activeTagIds: number[];
  onToggle: (id: number) => void;
  onClear: () => void;
}): React.JSX.Element | null {
  if (menu === null) return null;
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
      aria-label="Filter by tag"
      data-testid="tag-filter-menu"
      onKeyDown={handleMenuKeyDown}
    >
      <ContextMenuItems>
        {tags.length === 0 ? (
          <div
            data-testid="tag-filter-menu-empty"
          >
            <ContextMenuMessage>No tags yet — a tab’s own menu is where they are made.</ContextMenuMessage>
          </div>
        ) : (
          tags.map((t) => {
            const on = activeTagIds.includes(t.id);
            return (
              <ContextMenuItem
                key={t.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                data-testid="tag-filter-option"
                data-tag-id={t.id}

                onClick={() => onToggle(t.id)}
              >
                <ContextMenuColorDot color={t.color} size="filter" />
                <span className="min-w-0 truncate">{t.name}</span>
                {on && (
                  <span className="justify-self-end">
                    <Icon glyph={IconCheck} role="ui" />
                  </span>
                )}
              </ContextMenuItem>
            );
          })
        )}
        <ContextMenuSeparator aria-hidden />
        <ContextMenuItem
          type="button"
          role="menuitem"
          data-testid="tag-filter-clear"
          disabled={activeTagIds.length === 0}

          onClick={onClear}
        >
          <Icon glyph={IconClose} role="ui" />
          <span>Clear filter</span>
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
}: {
  treeFilter: string | null;
  setTreeFilter: (
    v: string | null | ((cur: string | null) => string | null),
  ) => void;
  settingsSections: readonly SettingsSectionDef[];
  activeSettingsSection: string;
}): React.JSX.Element {
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const query = (treeFilter ?? '').trim().toLowerCase();
  const rowHits = query ? searchSettingsRows(query) : [];
  const sections = settingsSections.filter((s) => !query || s.label.toLowerCase().includes(query) || s.keywords.some((keyword) => keyword.toLowerCase().includes(query)));
  return (
    <div className="grid gap-[var(--space-1)]">
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
        {query ? rowHits.length > 0 ? rowHits.map(({ section: s, title }) => {
          const Icon = SETTINGS_ICON_MAP[s.icon] ?? IconInfo;
          return <SettingsRailRow key={`${s.id}:${title}`} kind="search" icon={Icon} label={title} subtitle={s.label} sectionId={s.id} rowTitle={title} onClick={() => { requestSettingsRowJump(s.id, title); setSettingsSection(s.id); setTreeFilter(null); }} />
        }) : <EmptyListMessage kind="settings">No settings match your search.</EmptyListMessage> : sections.map((s) => {
              const Icon = SETTINGS_ICON_MAP[s.icon] ?? IconInfo;
              const on = activeSettingsSection === s.id;
              return <SettingsRailRow key={s.id} kind="section" icon={Icon} label={s.label} selected={on} sectionId={s.id} onClick={() => setSettingsSection(s.id)} />;
            })}
      </SettingsNavigation>
    </div>
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
      <Button ref={trigger} variant="compact-icon-secondary" aria-label="Add workspace" aria-haspopup="menu" aria-expanded={position !== null}
        onClick={() => {
          const rect = trigger.current!.getBoundingClientRect();
          setPosition(position ? null : { x: Math.max(8, Math.min(rect.right - 244, window.innerWidth - 252)), y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 88)) });
        }}><Icon glyph={IconPlus} role="ui" /></Button>
    </Tooltip>
    {position && portalOrNull(<ContextMenu ref={menuRef} role="menu" aria-label="Add workspace" className="" style={{ left: position.x, top: position.y }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) setPosition(null); }}>
      <ContextMenuItems>
        <ContextMenuItem type="button" role="menuitem" onClick={() => dispatch(onAddWorkspace)}><Icon glyph={IconFolder} role="ui" /><span>Local folder…</span></ContextMenuItem>
        <ContextMenuItem type="button" role="menuitem" data-testid="rail-ssh-connect" onClick={() => dispatch(onSshConnect)}><Icon glyph={IconServer} role="ui" /><span>Connect via SSH…</span></ContextMenuItem>
      </ContextMenuItems>
    </ContextMenu>)}
  </>;
}

function RailTree({
  treeLabel,
  filterOpen,
  activeFilterCount,
  filterLabel,
  onToggleFilter,
  onSshConnect,
  onAddWorkspace,
  selected,
  filteredWorkspaces,
  workspaces,
  pinnedWorkspaces,
  pinnedCount,
  sessions,
  colorOf,
  gridsByWorkspace,
  activeTagIds,
  tagById,
  dropIndex,
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
  openGridMenu,
  setGridRenaming,
  renaming,
  onRenameSubmit,
  onRenameCancel,
  onRemoveWorkspace,
  onOpenInspector,
  checkoutBranches,
  railDiffByDir,
  railPrByDir,
  railWidth,
}: {
  treeLabel: string;
  filterOpen: boolean;
  activeFilterCount: number;
  filterLabel: string;
  onToggleFilter: (e: React.MouseEvent) => void;
  onSshConnect: () => void;
  onAddWorkspace: () => void;
  selected: string;
  filteredWorkspaces: Workspace[];
  workspaces: Workspace[];
  pinnedWorkspaces: ReadonlySet<string>;
  pinnedCount: number;
  sessions: SessionInfo[];
  colorOf: (path: string) => string;
  gridsByWorkspace: Record<string, GridItem[]>;
  activeTagIds: number[];
  tagById: ReadonlyMap<number, TagInfo>;
  dropIndex: number | null;
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
  openGridMenu: (
    e: React.MouseEvent,
    path: string,
    grid: GridItem,
    canRemove: boolean,
  ) => void;
  setGridRenaming: (v: { path: string; gridId: string } | null) => void;
  renaming: string | null;
  onRenameSubmit: (path: string, name: string) => void;
  onRenameCancel: () => void;
  onRemoveWorkspace: (path: string) => void;
  checkoutBranches: ReadonlyMap<number, string>;
  railDiffByDir: ReadonlyMap<string, RailDiffTotals>;
  railPrByDir: ReadonlyMap<string, RailPrState>;
  railWidth: number;
  onOpenInspector?: (paneId: number, tab: "changes" | "pull-request") => void;
}): React.JSX.Element {
  return (
    <NavigationRailSection
      data-testid="rail-tree"
    >
      <TreeGroupHeader
        label={treeLabel}
        filterOpen={filterOpen}
        activeFilterCount={activeFilterCount}
        filterLabel={filterLabel}
        onToggleFilter={onToggleFilter}
        leadingAction={
          <AddWorkspaceMenu onAddWorkspace={onAddWorkspace} onSshConnect={onSshConnect} />
        }
      />

      {(
        <WorkspaceList dragging={dragPath !== null}>
          {filteredWorkspaces.map((w, i) => {
            const color = colorOf(w.path);
            const on = selected === w.path;
            const grids = gridsByWorkspace[w.path];
            const pinned = pinnedWorkspaces.has(w.path);
            const dropBefore = dropIndex === i &&
              dragPath !== null &&
              dragPath !== w.path && (
                <WorkspaceDropIndicator />
              );
            const groupLabel =
              pinnedCount === 0 ? null : i === 0 ? (
                <WorkspaceGroupLabel key="ws-group-pinned">Pinned</WorkspaceGroupLabel>
              ) : i === pinnedCount ? (
                <Fragment key="ws-group-folders">
                  <WorkspaceGroupDivider
                    data-testid="ws-pinned-divider"
                    role="separator"
                  >
                    <HorizontalRule />
                  </WorkspaceGroupDivider>
                  <WorkspaceGroupLabel>Folders</WorkspaceGroupLabel>
                </Fragment>
              ) : null;
            let row: React.JSX.Element;
            if (grids && grids.length > 0) {
              if (!isWsOpen(w.path)) {
                row = (
                  <CollapsedGridsRow
                    w={w}
                    i={i}
                    color={color}
                    renamingThis={renaming === w.path}
                    onRenameSubmit={onRenameSubmit}
                    onRenameCancel={onRenameCancel}
                    on={on}
                    pinned={pinned}
                    dragPath={dragPath}
                    dropBefore={dropBefore}
                    dragActiveRef={dragActiveRef}
                    startWsDrag={startWsDrag}
                    selected={selected}
                    onSelect={onSelect}
                    toggleWsOpen={toggleWsOpen}
                    openMenu={openMenu}
                  />
                );
              } else {
                row = (
                  <ExpandedGridsRow
                    w={w}
                    i={i}
                    color={color}
                    renamingThis={renaming === w.path}
                    onRenameSubmit={onRenameSubmit}
                    onRenameCancel={onRenameCancel}
                    on={on}
                    pinned={pinned}
                    grids={grids}
                    activeTagIds={activeTagIds}
                    tagById={tagById}
                    dragPath={dragPath}
                    dropBefore={dropBefore}
                    dragActiveRef={dragActiveRef}
                    startWsDrag={startWsDrag}
                    selected={selected}
                    onSelect={onSelect}
                    toggleWsOpen={toggleWsOpen}
                    openMenu={openMenu}
                    onNewWorkspaceSession={onNewWorkspaceSession}
                    selectedGridId={selectedGridId}
                    gridRenaming={gridRenaming}
                    onRenameGrid={onRenameGrid}
                    onRemoveGrid={onRemoveGrid}
                    onSelectGrid={onSelectGrid}
                    openGridMenu={openGridMenu}
                    setGridRenaming={setGridRenaming}
                    checkoutBranches={checkoutBranches}
                    sessions={sessions}
                    railDiffByDir={railDiffByDir}
                    railPrByDir={railPrByDir}
                    railWidth={railWidth}
                    onOpenInspector={onOpenInspector}
                  />
                );
              }
            } else if (renaming === w.path) {
              row = (
                <RenamingWorkspaceRow
                  w={w}
                  i={i}
                  color={color}
                  dropBefore={dropBefore}
                  onRenameSubmit={onRenameSubmit}
                  onRenameCancel={onRenameCancel}
                />
              );
            } else {
              row = (
                <PlainWorkspaceRow
                  w={w}
                  i={i}
                  color={color}
                  on={on}
                  pinned={pinned}
                  dragPath={dragPath}
                  dropBefore={dropBefore}
                  dragActiveRef={dragActiveRef}
                  startWsDrag={startWsDrag}
                  onSelect={onSelect}
                  openMenu={openMenu}
                  onRemoveWorkspace={onRemoveWorkspace}
                />
              );
            }
            return (
              <Fragment key={w.path}>
                {groupLabel}
                {row}
              </Fragment>
            );
          })}
          {dropIndex === filteredWorkspaces.length && dragPath !== null && (
            <WorkspaceDropIndicator />
          )}
          {filteredWorkspaces.length === 0 && (
            <EmptyListMessage>
              {workspaces.length === 0
                ? "No workspaces yet. The + above opens a git project folder."
                : activeFilterCount > 0
                  ? `No tab carries ${activeFilterCount === 1 ? "that tag" : "any of those tags"}. Clear the filter from the funnel above.`
                  : "No workspaces match your filter."}
            </EmptyListMessage>
          )}
        </WorkspaceList>
      )}
    </NavigationRailSection>
  );
}

export function Sidebar({
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
  selectedGridId = null,
  onNewWorkspaceSession,
  onAddGrid,
  onRenameGrid,
  onRemoveGrid,
  onOpenSettings,
  onOpenPalette,
  paletteChord,
  onHideRail,
  chromeTheme,
  onToggleChromeTheme,
  updateVersion,
  harnessAttention,
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
  const [tagMenu, setTagMenu] = useState<{
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [tagEditor, setTagEditor] = useState<TagEditorState | null>(null);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  // Name of the tag the quick editor just made, so the manager it hands over to
  // can point at the new row. Cleared whenever the manager is opened any other way.
  const [tagJustMade, setTagJustMade] = useState<string | null>(null);

  const settingsOpen = useSettingsOpen();
  const railWidth = useRailWidth();
  const railPrByDir = useRailPrCache();
  const railDiffByDir = useRailGitCache();
  const railView = useRailView();
  const hiddenRailViews = useHiddenRailViews();
  const { custom, dataCustom } = useCustomSurface();
  const activeSettingsSection = useSettingsSection();

  const [treeFilter, setTreeFilter] = useState<string | null>(null);
  const filterOpen = tagMenu !== null;
  const tags = useMemo(() => tagsProp ?? [], [tagsProp]);
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const activeTagIds = useMemo(
    () => tagFilter.filter((id) => tagById.has(id)),
    [tagFilter, tagById],
  );
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
  const [dropIndex, setDropIndex] = useState<number | null>(null);
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
      setDropIndex(idx);
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

  const colorOf = (path: string): string =>
    customColors[path] ?? workspaceColor(colorIndexByPath[path] ?? 0);

  useEffect(() => {
    if (!menu && !gridMenu && !navMenu && !tagMenu) return;
    const closeAll = (): void => {
      setMenu(null);
      setGridMenu(null);
      setNavMenu(null);
      setTagMenu(null);
    };
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (
        !target.closest(".ctxmenu") &&
        !target.closest('[data-testid="tree-filter-toggle"]')
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
  }, [menu, gridMenu, navMenu, tagMenu]);

  const openTagMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(8, Math.min(r.right - 244, window.innerWidth - 252));
    const y = Math.min(r.bottom + 4, window.innerHeight - 120);
    setMenu(null);
    setGridMenu(null);
    setNavMenu(null);
    setTagMenu({
      x,
      y,
      originX: r.left + r.width / 2 - x,
      originY: r.top - y,
    });
  };

  const onToggleFilter = (e: React.MouseEvent): void => {
    if (tagMenu !== null) setTagMenu(null);
    else openTagMenu(e);
  };

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
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    const x = Math.min(e.clientX, window.innerWidth - 244);
    const y = Math.min(e.clientY, window.innerHeight - 100);
    setGridMenu({
      x,
      y,
      originX: e.clientX - x,
      originY: e.clientY - y,
      path,
      gridId: grid.id,
      name: grid.name,
      canRemove,
      tagIds: grid.tagIds ?? [],
      ...railGridContextFacts(grid, path, sessions, checkoutBranches, railPrByDir),
    });
  };

  useEffect(() => {
    localStorage.setItem(TAG_FILTER_KEY, JSON.stringify(activeTagIds));
  }, [activeTagIds]);
  const activeFilterCount = activeTagIds.length;
  const filterLabel = filterLabelFor(activeTagIds.length);

  const tagUsage = useMemo(() => {
    const m = new Map<number, TagUsage>();
    const at = (t: number): TagUsage => {
      const u = m.get(t) ?? { panes: 0, grids: 0 };
      m.set(t, u);
      return u;
    };
    for (const s of sessions) for (const t of tagsOf(s)) at(t).panes += 1;
    for (const grids of Object.values(gridsByWorkspace ?? {}))
      for (const g of grids) for (const t of g.tagIds ?? []) at(t).grids += 1;
    return m;
  }, [sessions, gridsByWorkspace]);

  const toggleTagFilter = (id: number): void => {
    setTagFilter((cur) =>
      cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id],
    );
  };

  const addTagFilters = (ids: number[]): void => {
    setTagFilter((cur) => [...cur, ...ids.filter((id) => !cur.includes(id))]);
  };

  const toggleGridTag = (menu: GridCtxMenu, tagId: number): void => {
    const on = menu.tagIds.includes(tagId);
    if (!on && menu.tagIds.length >= MAX_TAGS_PER_GRID) {
      onOpenExternalError?.(
        `refused: grid "${menu.name}" already carries ${menu.tagIds.length} tags (the MAX_TAGS_PER_GRID cap of ${MAX_TAGS_PER_GRID})`,
      );
      return;
    }
    const next = on
      ? menu.tagIds.filter((t) => t !== tagId)
      : [...menu.tagIds, tagId];
    setGridMenu({ ...menu, tagIds: next });
    onSetGridTags?.(menu.path, menu.gridId, next);
  };

  const openTagEditorAt = (e: React.MouseEvent, tag: TagInfo | null): void => {
    e.stopPropagation();
    setGridMenu(null);
    setTagEditor({ x: e.clientX, y: e.clientY, tag });
  };

  const saveTag = (
    name: string,
    color: string,
    editing: TagInfo | null,
  ): void => {
    setTagEditor(null);
    if (editing) {
      onTagUpdate?.(editing.id, name, color);
      return;
    }
    // A new tag lands you in the manager, where it can be renamed, recoloured or
    // deleted — the quick editor is a way in, not a dead end.
    onTagCreate?.(name, color);
    setTagJustMade(name);
    setTagManagerOpen(true);
  };

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

  const gridMenuEl = gridMenu && (
    <GridContextMenu
      gridMenu={gridMenu}
      workspaces={workspaces}
      tags={tags}
      onClose={() => setGridMenu(null)}
      onStartRename={(path, gridId) => setGridRenaming({ path, gridId })}
      onRemoveGrid={onRemoveGrid}
      onToggleTag={toggleGridTag}
      onFilterByTags={addTagFilters}
      onNewTag={(e) => openTagEditorAt(e, null)}
      onManageTags={() => {
        setGridMenu(null);
        setTagJustMade(null);
        setTagManagerOpen(true);
      }}
      onOpenInspector={(paneId, tab) => onOpenInspector?.(paneId, tab)}
      onError={onOpenExternalError}
    />
  );

  const tagEditorEl = (
    <TagEditorSurface
      state={tagEditor}
      tags={tags}
      onSave={saveTag}
      onCancel={() => setTagEditor(null)}
      onTagCreate={onTagCreate}
      onTagUpdate={onTagUpdate}
    />
  );

  const tagManagerEl = (
    <TagManagerSurface
      open={tagManagerOpen}
      tags={tags}
      usage={tagUsage}
      highlight={tagJustMade}
      onClose={() => {
        setTagManagerOpen(false);
        setTagJustMade(null);
      }}
      onTagCreate={onTagCreate}
      onTagUpdate={onTagUpdate}
      onTagDelete={onTagDelete}
    />
  );

  const navMenuEl = (
    <NavViewMenu
      navMenu={navMenu}
      onClose={() => setNavMenu(null)}
      onHide={(v) => setRailViewHidden(v, true)}
    />
  );

  const tagMenuEl = (
    <TagFilterMenu
      menu={tagMenu}
      tags={tags}
      activeTagIds={activeTagIds}
      onToggle={toggleTagFilter}
      onClear={() => setTagFilter([])}
    />
  );

  const treeLabel = "Workspaces";

  const settingsSections = NAVIGABLE_SETTINGS_SECTIONS;

  return (
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
          view={railView}
          hidden={hiddenRailViews}
          paletteChord={paletteChord}
          taskTurnCount={taskTurnCount}
          onOpenPalette={onOpenPalette ?? (() => {})}
          onSelect={selectRailView}
          onRowMenu={openNavMenu}
          harnessAttention={harnessAttention}
        />
      )}
      <NavigationRailScroll>
        {settingsOpen ? (
          <SettingsTree
            treeFilter={treeFilter}
            setTreeFilter={setTreeFilter}
            settingsSections={settingsSections}
            activeSettingsSection={activeSettingsSection}
          />
        ) : (
          <RailTree
            treeLabel={treeLabel}
            filterOpen={filterOpen}
            activeFilterCount={activeFilterCount}
            filterLabel={filterLabel}
            onToggleFilter={onToggleFilter}
            onSshConnect={onSshConnect}
            onOpenInspector={onOpenInspector}
            checkoutBranches={checkoutBranches}
            railDiffByDir={railDiffByDir}
            railPrByDir={railPrByDir}
            railWidth={railWidth}
            onAddWorkspace={onAddWorkspace}
            selected={selected}
            filteredWorkspaces={filteredWorkspaces}
            workspaces={workspaces}
            pinnedWorkspaces={pinnedWorkspaces}
            pinnedCount={pinnedCount}
            sessions={sessions}
            colorOf={colorOf}
            gridsByWorkspace={gridsByWorkspace}
            activeTagIds={activeTagIds}
            tagById={tagById}
            dropIndex={dropIndex}
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
            onRemoveGrid={onRemoveGrid}
            onSelectGrid={onSelectGrid}
            openGridMenu={openGridMenu}
            setGridRenaming={setGridRenaming}
            renaming={renaming}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
            onRemoveWorkspace={onRemoveWorkspace}
          />
        )}
      </NavigationRailScroll>

      <NavigationRailFooter>
        {}
        <Tooltip label="Settings">
          <Button
            variant="subtle-icon"
            aria-label="Settings"
            aria-pressed={settingsOpen}
            selected={settingsOpen}
            onClick={onOpenSettings}
          >
            <Icon glyph={IconGear} role="ui" />
          </Button>
        </Tooltip>
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
      {portalOrNull(navMenuEl)}
      {portalOrNull(tagMenuEl)}
      {portalOrNull(tagEditorEl)}
      {portalOrNull(tagManagerEl)}
    </RailSurface>
  );
}
