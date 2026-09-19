import type { TagInfo } from "../houston/generated/TagInfo";
import { MAX_TAGS_PER_SESSION } from "../houston/generated/DEFAULTS";
import { TagChipRow } from "./tags";
import type { TagEditorState } from "./tagEditing";
import { FOCUS_HALO } from "./shadowChrome";
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
import type { SessionInfo, Workspace } from "../houston/client";
import { isLive } from "../houston/client";
import { RAIL_TAG_DOT_AT, useRailWidth } from "../railWidth";
import type { ChromeTheme } from "../theme";
import {
  setSettingsOpen,
  setSettingsSection,
  useSettingsOpen,
  useSettingsSection,
} from "../settingsNav";
import { useCustomSurface } from "./customChrome";
import {
  SETTINGS_GROUPS,
  NAVIGABLE_SETTINGS_SECTIONS,
  type SettingsGroupDef,
  type SettingsSectionDef,
} from "../settingsSections";
import { translateFilteredDropIndex } from "../layout/wsOrder";
import {
  IconArrowUp,
  IconBell,
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
  IconMoon,
  IconPanelLeft,
  IconPalette,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconSun,
  IconServer,
  IconUser,
  IconTarget,
  IconChartArea,
  IconTerminal,
  IconZap,
  IconGlobe,
  IconClock,
  type IconProps,
} from "./icons";
import { Tooltip } from "./Tooltip";
import logoUrl from "../assets/logo-chrome.svg";
import { showItemInFolder } from "../houston/bridge";
import { OpenInMenu } from "./OpenInMenu";
import { ICON_ROLE_CLS, Icon } from "./Icon";
import {
  RAIL_VIEWS,
  RAIL_VIEW_LABEL,
  setRailViewHidden,
  toggleRailView,
  useHiddenRailViews,
  useRailView,
  type RailView,
} from "../railView";
import { MATERIAL_CLS, materialAttrs } from "./material";
import { HIT_TARGET_28 } from "./hitTarget";
import { BTN_ICO_STRUCTURE } from "./buttonChrome";
import { CONTROL_SIZE_SQUARE_CLS } from "./controlSize";

const SETTINGS_ICON_MAP: Record<string, (p: IconProps) => React.JSX.Element> = {
  palette: IconPalette,
  terminal: IconTerminal,
  keyboard: IconKeyboard,
  bell: IconBell,
  user: IconUser,
  folder: IconFolder,
  fork: IconGitFork,
  sparkles: IconSparkles,
  mic: IconMic,
  database: IconDatabase,
  chart: IconChartArea,
  target: IconTarget,
  info: IconInfo,
  wrench: IconWrench,
  server: IconServer,
};

export const RAIL_SELECTED_CLS = "bg-selected-fill text-[var(--text-primary)]";

const WS_SUBGROUP_LABEL_CLS =
  "px-2 pt-2 pb-1 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] tracking-[0.1em] uppercase text-[var(--text-faint)] select-none";

const WS_SUBGROUP_RULE_CLS = "mx-2 pt-[var(--space-2)]";

const COUNT_CHIP_CLS =
  "flex-none min-w-[17px] h-[17px] leading-[17px] rounded-[6px] px-[5px] font-mono [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-center tabular-nums bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-faint)]";

const CHEVRON_HIT_CLS = `flex-none -ml-[3px] flex items-center justify-center w-[18px] h-[18px] rounded-[var(--tr-radius-input)] text-current hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] ${HIT_TARGET_28}`;

const FOOT_ICON_BTN = `${BTN_ICO_STRUCTURE} ${CONTROL_SIZE_SQUARE_CLS.regular} rounded-[var(--tr-radius-sm)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]`;

// Glyph and version in one button, not a square: the version rides inside it, so
// there is one hit target, one focus ring and one tooltip over the pair.
const FOOT_UPDATE_BTN = `${BTN_ICO_STRUCTURE} ml-auto h-[var(--h-ctl)] gap-[3px] pl-[5px] pr-[4px] rounded-[var(--tr-radius-sm)] bg-transparent text-[var(--accent)] hover:bg-[var(--card-hover)]`;

// Its own component so the foot keeps no branch of its own: nothing at all is
// rendered until a release is actually waiting.
function RailUpdateButton({ version }: { version?: string | null }): React.JSX.Element | null {
  if (version == null) return null;
  return (
    <Tooltip label={`Houston v${version} is available`}>
      <button
        type="button"
        data-testid="rail-update-available"
        aria-label={`Houston v${version} is available`}
        className={FOOT_UPDATE_BTN}
        onClick={() => {
          setSettingsSection("about");
          setSettingsOpen(true);
        }}
      >
        <Icon glyph={IconArrowUp} role="ui" />
        <span className="font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] px-1.5 py-0.5 rounded-[var(--tr-radius-sm)] bg-[var(--accent-muted)] flex-none">
          {version}
        </span>
      </button>
    </Tooltip>
  );
}

const GROUP_ADD_CLS =
  "w-6 h-6 flex-none rounded-[var(--tr-radius-sm)] border-0 bg-transparent flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]";

const GROUP_ACTION_CLS =
  "relative w-6 h-6 flex-none rounded-[var(--tr-radius-sm)] border-0 bg-transparent flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]";

const FILTER_BADGE_CLS =
  "absolute -top-[2px] -right-[2px] min-w-[13px] h-[13px] px-[2px] rounded-full bg-[var(--accent)] text-white [font-size:9px] [font-weight:var(--tr-text-label-weight)] leading-[13px] text-center tabular-nums";

function GroupHeader({
  label,
  variant = "trio",
  filterOpen,
  activeFilterCount,
  filterLabel,
  onToggleFilter,
  onSshConnect,
  leadingAction,
}: {
  label: string;
  variant?: "trio" | "plus-only";
  filterOpen: boolean;
  activeFilterCount: number;
  filterLabel: string;
  onToggleFilter: (e: React.MouseEvent) => void;
  onSshConnect: () => void;
  leadingAction?: React.ReactNode;
}): React.JSX.Element {
  const plusOnly = variant === "plus-only";
  return (
    <div
      data-testid="tree-group-header"
      className="flex items-center gap-[var(--space-1)] px-[var(--space-4)] pt-[var(--space-4)] pb-[var(--space-1-5)] h-[30px]"
    >
      {}
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [font-size:var(--tr-text-ui-size)] [font-weight:600] text-[var(--text-primary)]">
        {label}
      </span>
      <span className="flex flex-none gap-[2px]">
        <Tooltip label={filterLabel}>
          <button
            type="button"
            aria-label={filterLabel}
            aria-expanded={filterOpen}
            data-testid="tree-filter-toggle"
            onClick={onToggleFilter}
            className={GROUP_ACTION_CLS}
          >
            <Icon glyph={IconFilter} role="ui" />
            {activeFilterCount > 0 && (
              <span aria-hidden data-testid="tree-filter-badge" className={FILTER_BADGE_CLS}>
                {activeFilterCount > 9 ? "9+" : activeFilterCount}
              </span>
            )}
          </button>
        </Tooltip>
        {plusOnly ? null : (
          <Tooltip label="Connect over SSH">
            <button
              type="button"
              aria-label="Connect over SSH"
              data-testid="rail-ssh-connect"
              onClick={onSshConnect}
              className={GROUP_ACTION_CLS}
            >
              <Icon glyph={IconServer} role="ui" />
            </button>
          </Tooltip>
        )}
      </span>
      <span className="flex flex-none">{leadingAction}</span>
    </div>
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

const tint = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

interface Props {
  workspaces: Workspace[];
  sessions: SessionInfo[];
  selected: string;
  customColors: Record<string, string>;
  colorIndexByPath: Record<string, number>;
  unreadByWs: Record<string, number>;
  owedByWs?: Record<string, number>;
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

  gridsByWorkspace?: Record<
    string,
    {
      id: string;
      name: string;
      count?: number;
      state?: "online" | "warning" | "idle";
      sessionIds?: number[];
      tagIds?: number[];
    }[]
  >;
  tags?: TagInfo[];
  onSetGridTags?: (
    path: string,
    gridId: string,
    sessionIds: number[],
    tagIds: number[],
  ) => void;
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
  onToggleChromeTheme: () => void;
  updateVersion?: string | null;

  className?: string;
  onHeadMouseDown?: (e: React.MouseEvent) => void;
  onHeadDoubleClick?: (e: React.MouseEvent) => void;
}

function liveCount(sessions: SessionInfo[]): number {
  return sessions.filter((s) => isLive(s.state)).length;
}

function attentionLabel(unread: number, owed: number): string {
  if (owed === 0) return `${unread} unread`;
  return `${unread} unread · ${owed} owed to you`;
}

function WorkspacePaneCount({
  panes,
  live,
  tagMatched,
  tagTotal,
}: {
  panes: number;
  live: number;
  tagMatched?: number;
  tagTotal?: number;
}): React.JSX.Element | null {
  if (tagMatched !== undefined && tagTotal !== undefined) {
    return (
      <Tooltip
        label={
          tagMatched === 0
            ? `none of ${tagTotal} panes carry the filter`
            : `${tagMatched} of ${tagTotal} panes carry the filter`
        }
      >
        <span data-testid="nav-count" className={COUNT_CHIP_CLS}>
          {tagMatched}/{tagTotal}
        </span>
      </Tooltip>
    );
  }
  if (panes <= 1) return null;
  return (
    <Tooltip
      label={live === 0 ? `${panes} panes, none running` : `${panes} panes`}
    >
      <span
        data-testid="nav-count"
        className={`${COUNT_CHIP_CLS} ${live === 0 ? "opacity-[0.55]" : ""}`}
      >
        {panes > 99 ? "99+" : panes}
      </span>
    </Tooltip>
  );
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
    <input
      ref={ref}
      className={`flex-1 min-w-0 bg-[var(--content-bg)] border border-[var(--accent)] rounded-[var(--tr-radius-sm)] text-[var(--text-primary)] [font-family:inherit] [font-weight:inherit] [font-style:inherit] [line-height:inherit] text-[length:var(--tr-text-md)] px-1.5 py-0.5 outline-none focus-visible:shadow-[${FOCUS_HALO}]`}
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
  sessionIds: number[];
  tagIds: number[];
}

const CTXMENU_CLS =
  "ctxmenu fixed z-[var(--z-context)] w-[244px] overflow-hidden bg-[var(--raised)] border border-[var(--border)] rounded-[10px] shadow-[var(--shadow-1)] flex flex-col motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [transform-origin:var(--pop-origin-x,center)_var(--pop-origin-y,center)] [&_.ctx-item]:grid [&_.ctx-item]:grid-cols-[18px_minmax(0,1fr)_auto] [&_.ctx-item]:items-center [&_.ctx-item]:gap-1.5 [&_.ctx-item]:w-full [&_.ctx-item]:h-[30px] [&_.ctx-item]:px-[7px] [&_.ctx-item]:py-0 [&_.ctx-item]:border-none [&_.ctx-item]:rounded-[6px] [&_.ctx-item]:bg-transparent [&_.ctx-item]:text-[var(--text-secondary)] [&_.ctx-item]:[font-size:var(--tr-text-label-size)] [&_.ctx-item]:font-normal [&_.ctx-item]:text-left [&_.ctx-item:hover]:bg-[var(--card-hover)] [&_.ctx-item:hover]:text-[var(--text-primary)] [&_.ctx-item:focus-visible]:bg-[var(--card-hover)] [&_.ctx-item:focus-visible]:text-[var(--text-primary)] [&_.ctx-item:focus-visible]:outline-none [&_.ctx-item:disabled]:text-[var(--text-faint)] [&_.ctx-item:disabled]:cursor-default [&_.ctx-item:disabled]:opacity-45 [&_.ctx-item_kbd]:text-[var(--text-faint)] [&_.ctx-item_kbd]:font-mono [&_.ctx-item_kbd]:[font-size:var(--tr-text-label-size)] [&_.ctx-item_kbd]:font-medium [&_.ctx-item>svg:first-child]:justify-self-center [&_.ctx-sep]:h-px [&_.ctx-sep]:bg-[var(--border)] [&_.ctx-sep]:my-1.5 [&_.ctx-sep]:mx-0 [&_.ctx-sep]:flex-none [&_.ctx-item.danger]:text-[color-mix(in_srgb,var(--danger)_80%,transparent)] [&_.ctx-item.danger:hover]:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] [&_.ctx-item.danger:hover]:text-[var(--danger)]";

const CTX_HEADER_CLS =
  "flex flex-col justify-center gap-0.5 min-h-[48px] px-[10px] py-[7px] border-b border-[var(--divider)]";

const CTX_ITEMS_CLS = "flex flex-col gap-[1px] p-[5px]";

function ctxHeader(title: string, subtitle: string): React.JSX.Element {
  return (
    <div className={CTX_HEADER_CLS}>
      <strong className="block truncate [font-size:var(--tr-text-small-size)] [font-weight:650] text-[var(--text-primary)]">
        {title}
      </strong>
      <small className="block truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
        {subtitle}
      </small>
    </div>
  );
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
  usage: Map<number, number>;
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
    <div
      className={CTXMENU_CLS}
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
      <div className={CTX_ITEMS_CLS}>
        {onAddGrid && (
          <button
            className="btn ctx-item"
            role="menuitem"
            data-testid="ws-new-grid"
            onClick={() => {
              const { path } = menu;
              onClose();
              onAddGrid(path);
            }}
          >
            <Icon glyph={IconPlus} role="ui" />
            <span>New Grid</span>
          </button>
        )}
        <button
          className="btn ctx-item"
          role="menuitem"
          onClick={() => {
            onClose();
            onRenameStart(menu.path);
          }}
        >
          <Icon glyph={IconPencil} role="ui" />
          <span>Rename Workspace</span>
          <kbd>F2</kbd>
        </button>
        <button
          className="btn ctx-item"
          role="menuitem"
          data-testid="ws-toggle-pin"
          onClick={() => {
            const { path } = menu;
            onClose();
            onTogglePin(path);
          }}
        >
          <Icon glyph={IconPin} role="ui" />
          <span>{menu.pinned ? "Unpin Workspace" : "Pin Workspace"}</span>
        </button>
        <button
          className="btn ctx-item"
          role="menuitem"
          onClick={() => {
            const { path } = menu;
            onClose();
            void showItemInFolder(path);
          }}
        >
          <Icon glyph={IconFolder} role="ui" />
          <span>Reveal in Files</span>
        </button>
        <OpenInMenu
          path={menu.path}
          label="Open Workspace In"
          icon={<Icon glyph={IconCodeXml} role="ui" />}
          itemClass="ctx-item"
          onDone={onClose}
          onError={onOpenExternalError ?? (() => {})}
        />
        <div className="ctx-sep" />
        <button
          className="btn ctx-item danger"
          role="menuitem"
          onClick={() => {
            onClose();
            onRemoveWorkspace(menu.path);
          }}
        >
          <Icon glyph={IconClose} role="ui" />
          <span>Remove Workspace</span>
          <kbd>Ctrl+Shift+W</kbd>
        </button>
      </div>
    </div>
  );
}

function GridContextMenu({
  gridMenu,
  workspaces,
  sessions,
  tags,
  onClose,
  onStartRename,
  onRemoveGrid,
  onToggleTag,
  onFilterByTags,
  onNewTag,
  onManageTags,
}: {
  gridMenu: GridCtxMenu;
  workspaces: Workspace[];
  sessions: SessionInfo[];
  tags: TagInfo[];
  onClose: () => void;
  onStartRename: (path: string, gridId: string) => void;
  onRemoveGrid?: (path: string, gridId: string) => void;
  onToggleTag: (menu: GridCtxMenu, tagId: number) => void;
  onFilterByTags: (tagIds: number[]) => void;
  onNewTag: (e: React.MouseEvent) => void;
  onManageTags: () => void;
}): React.JSX.Element {
  const workspaceName =
    workspaces.find((w) => w.path === gridMenu.path)?.name ?? gridMenu.path;
  const taggable = gridMenu.sessionIds.length > 0;
  return (
    <div
      className={CTXMENU_CLS}
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
      <div className={CTX_ITEMS_CLS}>
        <button
          className="btn ctx-item"
          role="menuitem"
          onClick={() => {
            onStartRename(gridMenu.path, gridMenu.gridId);
            onClose();
          }}
        >
          <Icon glyph={IconPencil} role="ui" />
          <span>Rename</span>
        </button>
        {gridMenu.canRemove && (
          <button
            className="btn ctx-item danger"
            role="menuitem"
            onClick={() => {
              const { path, gridId } = gridMenu;
              onClose();
              onRemoveGrid?.(path, gridId);
            }}
          >
            <Icon glyph={IconClose} role="ui" />
            <span>Close Tab</span>
          </button>
        )}
        {taggable && tags.length > 0 && (
          <>
            <div className="ctx-sep" />
            <div
              role="presentation"
              className="px-[8px] pt-[3px] pb-[1px] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[0.1em] text-[var(--text-faint)]"
            >
              Tags
            </div>
            {tags.map((t) => {
              const on = gridMenu.tagIds.includes(t.id);
              const capBlocked =
                !on &&
                gridMenu.sessionIds.some((sid) => {
                  const s = sessions.find((x) => x.id === sid);
                  return (
                    s !== undefined &&
                    !tagsOf(s).includes(t.id) &&
                    tagsOf(s).length >= MAX_TAGS_PER_SESSION
                  );
                });
              return (
                <button
                  key={t.id}
                  className="btn ctx-item"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  disabled={capBlocked}
                  data-testid="menu-tag-item"
                  data-tag={t.id}
                  onClick={() => onToggleTag(gridMenu, t.id)}
                >
                  <span
                    aria-hidden
                    className="w-[9px] h-[9px] rounded-full justify-self-center"
                    style={{ background: t.color }}
                  />
                  <span className="truncate">{t.name}</span>
                  {on && (
                    <span className="text-[var(--accent)]">
                      <Icon glyph={IconCheck} role="label" />
                    </span>
                  )}
                </button>
              );
            })}
            {gridMenu.tagIds.length > 0 && (
              <button
                className="btn ctx-item"
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
              </button>
            )}
          </>
        )}
        <div className="ctx-sep" />
        <button
          className="btn ctx-item"
          role="menuitem"
          data-testid="menu-new-tag"
          onClick={onNewTag}
        >
          <Icon glyph={IconPlus} role="ui" />
          <span>New tag…</span>
        </button>
        {tags.length > 0 && (
          <button
            className="btn ctx-item"
            role="menuitem"
            data-testid="menu-manage-tags"
            onClick={onManageTags}
          >
            <Icon glyph={IconGear} role="ui" />
            <span>Manage tags…</span>
          </button>
        )}
      </div>
    </div>
  );
}

type GridItem = {
  id: string;
  name: string;
  count?: number;
  state?: "online" | "warning" | "idle";
  sessionIds?: number[];
  tagIds?: number[];
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

function tagByIdOf(tags: TagInfo[], id: number): TagInfo | undefined {
  return tags.find((t) => t.id === id);
}

function PinIndicator(): React.JSX.Element {
  return (
    <Tooltip label="Pinned">
      <span
        aria-label="Pinned"
        data-testid="ws-pinned-indicator"
        className="flex-none flex items-center text-[var(--text-muted)]"
      >
        <Icon glyph={IconPin} role="small" />
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
  unread,
  owed,
  panes,
  tagMatched,
  tagTotal,
  live,
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
  unread: number;
  owed: number;
  panes: number;
  tagMatched?: number;
  tagTotal?: number;
  live: number;
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
        <div
          role="button"
          tabIndex={0}
          aria-label={w.path}
          data-ws-idx={i}
          data-testid="ws-disclosure"
          aria-current={on ? "true" : undefined}
          aria-expanded={false}
          data-dragging={dragPath === w.path || undefined}
          className={`witem treerow ws relative flex items-center gap-2 h-[var(--h-row)] px-2 rounded-md border-0 bg-transparent [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full group select-none hover:bg-hover-fill hover:text-[var(--text-primary)] text-[var(--text-secondary)] ${dragPath !== null ? "cursor-grabbing" : "cursor-pointer"} ${dragPath === w.path ? "opacity-[0.45]" : ""}`}
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
          <button
            type="button"
            aria-label={`Expand ${w.name}`}
            data-testid="ws-chevron"
            className={CHEVRON_HIT_CLS}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleWsOpen(w.path);
            }}
          >
            <span aria-hidden className="opacity-60">
              <Icon glyph={IconChevronRight} role="small" />
            </span>
          </button>
          <span aria-hidden className="flex-none opacity-70">
            <Icon glyph={IconFolder} role="ui" />
          </span>
          <span className="whitespace-nowrap overflow-hidden text-ellipsis">
            {w.name}
          </span>
          <span className="ml-auto flex items-center gap-1 flex-none">
            {pinned && <PinIndicator />}
            {unread + owed > 0 && (
              <Tooltip label={attentionLabel(unread, owed)}>
                <span className="flex-none min-w-4 h-4 leading-4 rounded-full px-1 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-center tabular-nums bg-[var(--accent)] text-white">
                  {unread + owed}
                </span>
              </Tooltip>
            )}
            <WorkspacePaneCount
              panes={panes}
              live={live}
              tagMatched={tagMatched}
              tagTotal={tagTotal}
            />
          </span>
        </div>
      </Tooltip>
    </Fragment>
  );
}

function GridStateDot({ state }: { state?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-testid="grid-state-dot"
      data-state={state ?? "idle"}
      className="w-[6px] h-[6px] rounded-full flex-none"
      style={{
        background:
          state === "online"
            ? "var(--online)"
            : state === "warning"
              ? "var(--warning)"
              : "var(--text-faint)",
      }}
    />
  );
}

// A tag filter is a filter, not a highlight: a tab carrying none of the active
// tags leaves the rail. Unknown membership (tagIds undefined) is not "carries
// none", so it stays — a filter must never hide what it cannot see.
function hiddenByTagFilter(
  tagIds: number[] | undefined,
  activeTagIds: number[],
): boolean {
  if (activeTagIds.length === 0 || tagIds === undefined) return false;
  return !tagIds.some((id) => activeTagIds.includes(id));
}

function workspaceCarriesTag(
  path: string,
  grids: GridItem[] | undefined,
  sessions: SessionInfo[],
  activeTagIds: number[],
): boolean {
  if (activeTagIds.length === 0) return true;
  if (grids && grids.length > 0)
    return grids.some((g) => !hiddenByTagFilter(g.tagIds, activeTagIds));
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

function GridTagChips({
  tagIds,
  tags,
  onToggle,
}: {
  tagIds: number[] | undefined;
  tags: TagInfo[];
  onToggle: (tag: TagInfo) => void;
}): React.JSX.Element | null {
  const railWidth = useRailWidth();
  if (tagIds === undefined) return null;
  return (
    <TagChipRow
      compact={railWidth < RAIL_TAG_DOT_AT}
      tags={tagIds
        .map((id) => tagByIdOf(tags, id))
        .filter((t): t is TagInfo => t !== undefined)}
      onToggle={onToggle}
    />
  );
}

function ExpandedGridsRow({
  w,
  i,
  color,
  renamingThis,
  onRenameSubmit,
  onRenameCancel,
  on,
  unread,
  owed,
  panes,
  tagMatched,
  tagTotal,
  live,
  pinned,
  grids,
  tags,
  activeTagIds,
  onToggleTagFilter,
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
}: {
  w: Workspace;
  i: number;
  color: string;
  on: boolean;
  unread: number;
  owed: number;
  panes: number;
  tagMatched?: number;
  tagTotal?: number;
  live: number;
  pinned: boolean;
  grids: GridItem[];
  tags: TagInfo[];
  activeTagIds: number[];
  onToggleTagFilter: (id: number) => void;
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
        <div
          role="button"
          tabIndex={0}
          aria-label={w.path}
          data-ws-idx={i}
          data-testid="ws-disclosure"
          aria-current={on ? "true" : undefined}
          aria-expanded={true}
          data-dragging={dragPath === w.path || undefined}
          className={`witem treerow ws relative flex items-center gap-2 h-[var(--h-row)] px-2 rounded-md border-0 bg-transparent [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full group select-none hover:bg-hover-fill ${on ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"} ${dragPath !== null ? "cursor-grabbing" : "cursor-pointer"} ${dragPath === w.path ? "opacity-[0.45]" : ""}`}
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
          <button
            type="button"
            aria-label={`Collapse ${w.name}`}
            data-testid="ws-chevron"
            className={CHEVRON_HIT_CLS}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleWsOpen(w.path);
            }}
          >
            <span aria-hidden className="rotate-90">
              <Icon glyph={IconChevronRight} role="small" />
            </span>
          </button>
          <span aria-hidden className="flex-none opacity-70">
            <Icon glyph={IconFolder} role="ui" />
          </span>
          <span className="whitespace-nowrap overflow-hidden text-ellipsis">
            {w.name}
          </span>
          <span className="ml-auto flex items-center gap-1 flex-none">
            {pinned && <PinIndicator />}
            {unread + owed > 0 && !on && (
              <Tooltip label={attentionLabel(unread, owed)}>
                <span className="flex-none min-w-4 h-4 leading-4 rounded-full px-1 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-center tabular-nums bg-[var(--accent)] text-white">
                  {unread + owed}
                </span>
              </Tooltip>
            )}
            <WorkspacePaneCount
              panes={panes}
              live={live}
              tagMatched={tagMatched}
              tagTotal={tagTotal}
            />
          </span>
          {onNewWorkspaceSession && (
            <Tooltip label="New session">
              <button
                type="button"
                aria-label={`New session in ${w.name}`}
                data-testid="ws-new-session"
                className="hidden group-hover:inline-flex focus-visible:inline-flex items-center justify-center w-5 h-5 flex-none rounded-[var(--tr-radius-input)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)]"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewWorkspaceSession(w.path);
                }}
              >
                <Icon glyph={IconPlus} role="small" />
              </button>
            </Tooltip>
          )}
        </div>
      </Tooltip>
      )}
      {grids.map((g) => {
        if (hiddenByTagFilter(g.tagIds, activeTagIds)) return null;
        const gridOn =
          selected === w.path && selectedGridId === g.id;
        const stateDot = <GridStateDot state={g.state ?? undefined} />;
        if (
          gridRenaming?.path === w.path &&
          gridRenaming.gridId === g.id &&
          onRenameGrid
        ) {
          return (
            <div
              key={g.id}
              data-testid="grid-row-renaming"
              className="treerow child relative flex items-center gap-2 h-[var(--h-row)] pl-8 pr-2 rounded-md border-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full text-[var(--text-primary)]"
            >
              {stateDot}
              <span aria-hidden className="flex-none opacity-70">
                <Icon glyph={IconGrid} role="ui" />
              </span>
              <RenameInput
                initial={g.name}
                onSubmit={(name) => {
                  setGridRenaming(null);
                  const next = name.trim();
                  if (next && next !== g.name) onRenameGrid(w.path, g.id, next);
                }}
                onCancel={() => setGridRenaming(null)}
              />
            </div>
          );
        }
        return (
          <div
            key={g.id}
            role="button"
            tabIndex={0}
            data-testid="grid-row"
            data-selected={gridOn ? "true" : undefined}
            aria-current={gridOn ? "true" : undefined}
            className={`treerow child relative flex items-center gap-2 h-[var(--h-row)] pl-8 pr-2 rounded-md border-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full group hover:bg-hover-fill hover:text-[var(--text-primary)] ${gridOn ? RAIL_SELECTED_CLS : "bg-transparent text-[var(--text-secondary)]"}`}
            onClick={() => {
              onSelectGrid?.(w.path, g.id);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelectGrid?.(w.path, g.id);
            }}
            onContextMenu={
              onRenameGrid || onRemoveGrid
                ? (e) =>
                    openGridMenu(
                      e,
                      w.path,
                      g,
                      Boolean(onRemoveGrid) && grids.length > 1,
                    )
                : undefined
            }
          >
            {stateDot}
            <span aria-hidden className="flex-none opacity-70">
              <Icon glyph={IconGrid} role="ui" />
            </span>
            <span className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">
              {g.name}
            </span>
            <GridTagChips
              tagIds={g.tagIds}
              tags={tags}
              onToggle={(t) => onToggleTagFilter(t.id)}
            />
            {g.count !== undefined && g.count > 1 && (
              <span data-testid="nav-count" className={COUNT_CHIP_CLS}>
                {g.count}
              </span>
            )}
            {onRemoveGrid && grids.length > 1 && (
              <Tooltip label="Close tab">
                <button
                  type="button"
                  aria-label="Close tab"
                  data-testid="grid-close"
                  className="hidden group-hover:inline-flex focus-visible:inline-flex items-center justify-center w-5 h-5 flex-none rounded-[var(--tr-radius-input)] text-[var(--text-faint)] hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] hover:text-[var(--danger)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveGrid(w.path, g.id);
                  }}
                >
                  <Icon glyph={IconClose} role="small" />
                </button>
              </Tooltip>
            )}
          </div>
        );
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
    <div
      data-ws-idx={i}
      data-testid="ws-row-renaming"
      className="witem relative flex items-center gap-2 h-[var(--h-row)] py-0 px-2 rounded-md border-0 text-[var(--text-primary)] text-[length:var(--tr-text-md)] [font-weight:var(--tr-text-ui-weight)] text-left w-full"
      style={{
        background: tint(color, 12),
        boxShadow: `inset 0 0 0 1px ${tint(color, 35)}`,
      }}
    >
      <span
        aria-hidden
        className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-[3px]"
        style={{ background: color }}
      />
      <RenameInput
        initial={w.name}
        onSubmit={(name) => onRenameSubmit(w.path, name)}
        onCancel={onRenameCancel}
      />
    </div>
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
  unread,
  owed,
  allCount,
  ownCount,
  tagMatched,
  tagTotal,
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
  unread: number;
  owed: number;
  allCount: number;
  ownCount: number;
  tagMatched?: number;
  tagTotal?: number;
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
        <div
          role="button"
          tabIndex={0}
          aria-label={w.path}
          data-ws-idx={i}
          aria-current={on ? "true" : undefined}
          data-dragging={dragPath === w.path || undefined}
          className={`witem relative flex items-center gap-2 h-[var(--h-row)] py-0 px-2 rounded-md border-0 text-[length:var(--tr-text-md)] [font-weight:var(--tr-text-ui-weight)] text-left w-full group select-none hover:bg-hover-fill hover:text-[var(--text-primary)] ${on ? `${RAIL_SELECTED_CLS} on` : "bg-transparent text-[var(--text-secondary)]"} ${dragPath !== null ? "cursor-grabbing" : "cursor-pointer"} ${dragPath === w.path ? "opacity-[0.45]" : ""}`}
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
          <span aria-hidden className="flex-none opacity-70">
            <Icon glyph={IconFolder} role="ui" />
          </span>
          <span className="whitespace-nowrap overflow-hidden text-ellipsis">
            {w.name}
          </span>
          <span className="ml-auto flex gap-1">
            {pinned && <PinIndicator />}
            {unread + owed > 0 && !on && (
              <Tooltip label={attentionLabel(unread, owed)}>
                <span className="min-w-4 h-4 leading-4 rounded-full px-1 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-center tabular-nums bg-[var(--accent)] text-white">
                  {unread + owed}
                </span>
              </Tooltip>
            )}
            <WorkspacePaneCount
              panes={allCount}
              live={ownCount}
              tagMatched={tagMatched}
              tagTotal={tagTotal}
            />
            <Tooltip label="Close workspace (stops its agents)">
              <button
                type="button"
                aria-label="Close workspace (stops its agents)"
                className={`items-center justify-center w-5 h-5 p-0 flex-none text-[var(--text-muted)] rounded-[var(--tr-radius-input)] leading-[0] hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)] group-hover:inline-flex focus-visible:inline-flex ${on ? "inline-flex" : "hidden"}`}
                style={on ? { color } : undefined}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveWorkspace(w.path);
                }}
              >
                <Icon glyph={IconClose} role="small" />
              </button>
            </Tooltip>
          </span>
        </div>
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
    <div
      className="h-[var(--h-railhead)] flex-none flex items-center gap-[var(--space-3)] px-[var(--space-3)] [-webkit-app-region:drag] select-none"
      onMouseDown={onHeadMouseDown}
      onDoubleClick={onHeadDoubleClick}
    >
      <img
        data-testid="brand-mark"
        className="w-[var(--sz-brand-mark)] h-[var(--sz-brand-mark)] flex-none [-webkit-app-region:no-drag]"
        src={logoUrl}
        alt=""
      />
      <span className="min-w-0 font-semibold [font-size:var(--tr-text-ui-size)] tracking-[-0.025em] whitespace-nowrap overflow-hidden text-ellipsis [-webkit-app-region:no-drag]">
        Houston
      </span>
      {onHideRail && (
        <Tooltip label="Hide sidebar (Ctrl+B)">
          <button
            type="button"
            aria-label="Hide sidebar"
            className={`${FOOT_ICON_BTN} ml-auto [-webkit-app-region:no-drag]`}
            onClick={onHideRail}
          >
            <Icon glyph={IconPanelLeft} role="ui" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

const RAIL_VIEW_ICON: Readonly<Record<RailView, (p: IconProps) => React.JSX.Element>> =
  Object.freeze({
    skills: IconZap,
    routines: IconClock,
    mcp: IconGlobe,
  });

const RAIL_SEARCH_CLS =
  "btn flex w-full items-center h-[var(--h-ctl)] px-[var(--space-2)] gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-left hover:bg-[var(--card-hover)] hover:text-[var(--text-muted)]";

const RAIL_SEARCH_CAP_CLS =
  "min-w-[16px] px-[4px] py-px rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--card-hover)] font-mono [font-size:9px] leading-[1.3] text-[var(--text-faint)]";

const RAIL_NAV_ROW_CLS =
  "btn flex w-full items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent [font-size:var(--tr-text-ui-size)] [font-weight:500] tracking-[-0.01em] text-left text-[var(--text-secondary)] hover:bg-hover-fill hover:text-[var(--text-primary)]";

function RailNav({
  view,
  hidden,
  paletteChord,
  onOpenPalette,
  onSelect,
  onRowMenu,
}: {
  view: RailView | null;
  hidden: ReadonlySet<RailView>;
  paletteChord: string | null | undefined;
  onOpenPalette: (() => void) | undefined;
  onSelect: (v: RailView) => void;
  onRowMenu: (e: React.MouseEvent, v: RailView) => void;
}): React.JSX.Element {
  const shown = RAIL_VIEWS.filter((v) => !hidden.has(v));
  return (
    <div className="flex-none flex flex-col gap-[2px] px-[var(--space-2)] pt-[var(--space-2)] pb-[var(--space-1)]">
      <Tooltip label={paletteChord ? `Search (${paletteChord})` : "Search"}>
        <button
          type="button"
          data-testid="rail-search"
          className={RAIL_SEARCH_CLS}
          onClick={onOpenPalette}
        >
          <Icon glyph={IconSearch} role="small" />
          <span className="flex-1 min-w-0 truncate">Search</span>
          {paletteChord && (
            <span aria-hidden className="flex flex-none gap-[3px]">
              {paletteChord.split("+").map((k) => (
                <span key={k} className={RAIL_SEARCH_CAP_CLS}>
                  {k}
                </span>
              ))}
            </span>
          )}
        </button>
      </Tooltip>
      {shown.map((v) => {
        const on = view === v;
        return (
          <button
            key={v}
            type="button"
            data-testid="rail-nav-row"
            data-view={v}
            aria-current={on ? "page" : undefined}
            className={`${RAIL_NAV_ROW_CLS} ${on ? RAIL_SELECTED_CLS : ""}`}
            onClick={() => onSelect(v)}
            onContextMenu={(e) => onRowMenu(e, v)}
          >
            <span
              className={`flex flex-none ${on ? "text-[var(--accent)]" : "text-[var(--text-faint)]"}`}
            >
              <Icon glyph={RAIL_VIEW_ICON[v]} role="ui" />
            </span>
            <span className="min-w-0 truncate">{RAIL_VIEW_LABEL[v]}</span>
          </button>
        );
      })}
    </div>
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
    <div
      className={CTXMENU_CLS}
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
      <div className={CTX_ITEMS_CLS}>
        <button
          className="btn ctx-item"
          role="menuitem"
          data-testid="nav-hide-row"
          onClick={() => {
            onHide(navMenu.view);
            onClose();
          }}
        >
          <Icon glyph={IconEyeOff} role="ui" />
          <span>Hide from sidebar</span>
        </button>
      </div>
    </div>
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
    <div
      className={CTXMENU_CLS}
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
      <div className={CTX_ITEMS_CLS}>
        {tags.length === 0 ? (
          <div
            data-testid="tag-filter-menu-empty"
            className="px-[7px] py-[6px] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)]"
          >
            No tags yet — a tab’s own menu is where they are made.
          </div>
        ) : (
          tags.map((t) => {
            const on = activeTagIds.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                data-testid="tag-filter-option"
                data-tag-id={t.id}
                className="btn ctx-item"
                onClick={() => onToggle(t.id)}
              >
                <span
                  aria-hidden
                  className="w-[6px] h-[6px] rounded-full justify-self-center"
                  style={{ background: t.color }}
                />
                <span className="min-w-0 truncate">{t.name}</span>
                {on && (
                  <span className="justify-self-end">
                    <Icon glyph={IconCheck} role="ui" />
                  </span>
                )}
              </button>
            );
          })
        )}
        <div className="ctx-sep" aria-hidden />
        <button
          type="button"
          role="menuitem"
          data-testid="tag-filter-clear"
          disabled={activeTagIds.length === 0}
          className="btn ctx-item"
          onClick={onClear}
        >
          <Icon glyph={IconClose} role="ui" />
          <span>Clear filter</span>
        </button>
      </div>
    </div>
  );
}

function SettingsTree({
  treeFilter,
  setTreeFilter,
  settingsGroupRows,
  activeSettingsSection,
}: {
  treeFilter: string | null;
  setTreeFilter: (
    v: string | null | ((cur: string | null) => string | null),
  ) => void;
  settingsGroupRows: {
    group: SettingsGroupDef;
    sections: SettingsSectionDef[];
  }[];
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
  return (
    <>
      <div className="px-[var(--space-3)] pt-[var(--space-3)] pb-[var(--space-2)]">
        <input
          ref={filterRef}
          type="text"
          value={treeFilter ?? ""}
          onChange={(e) => setTreeFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setTreeFilter(null);
            }
          }}
          placeholder="Filter settings…  /"
          aria-label="Filter settings"
          className="w-full h-7 px-2 rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] outline-none focus-visible:border-[var(--accent)]"
        />
      </div>
      <nav className="flex flex-col gap-2 p-2" aria-label="Settings sections">
        {settingsGroupRows.map(({ group, sections }) => (
          <Fragment key={group.id}>
            {}
            {group.quiet ? (
              <div
                aria-hidden
                data-testid="settings-group-divider"
                className="mx-[var(--space-2)] border-t border-t-[var(--divider)]"
              />
            ) : (
              <div className="px-[var(--space-2)] pt-[var(--space-1)] pb-[2px]">
                <span className="[font-size:var(--tr-text-label-size)] font-semibold tracking-wider uppercase text-[var(--text-secondary)]">
                  {group.label}
                </span>
              </div>
            )}
            {sections.map((s) => {
              const Icon = SETTINGS_ICON_MAP[s.icon];
              const on = activeSettingsSection === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid="settings-section-row"
                  data-section-id={s.id}
                  data-quiet={group.quiet ? "true" : undefined}
                  aria-current={on ? "true" : undefined}
                  className={`treerow relative flex items-center gap-2 h-[var(--h-row)] px-2 rounded-[var(--tr-radius-sm)] border-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full hover:bg-hover-fill hover:text-[var(--text-primary)] ${
                    on
                      ? RAIL_SELECTED_CLS
                      : group.quiet
                        ? "bg-transparent text-[var(--text-muted)]"
                        : "bg-transparent text-[var(--text-secondary)]"
                  }`}
                  onClick={() => {
                    setSettingsSection(s.id);
                  }}
                >
                  {}
                  {!group.quiet && (
                    <span
                      className={`flex-none w-[14px] h-[14px] flex items-center justify-center ${on ? "text-[var(--accent)]" : "opacity-70"}`}
                    >
                      <Icon className={ICON_ROLE_CLS.ui} />
                    </span>
                  )}
                  <span className="whitespace-nowrap overflow-hidden text-ellipsis">
                    {s.label}
                  </span>
                </button>
              );
            })}
          </Fragment>
        ))}
        {settingsGroupRows.length === 0 && (
          <div className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] px-[10px] py-2 leading-[1.5]">
            No settings match your filter.
          </div>
        )}
      </nav>
    </>
  );
}

const RAIL_SLIDE_FROM_RIGHT =
  "motion-safe:animate-[rail-slide-in-right_var(--animate-t-panel)_var(--animate-ease-panel)]";

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
  unreadByWs,
  owedByWs = {},
  colorOf,
  gridsByWorkspace,
  tags,
  activeTagIds,
  onToggleTagFilter,
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
  unreadByWs: Record<string, number>;
  owedByWs?: Record<string, number>;
  colorOf: (path: string) => string;
  gridsByWorkspace: Record<string, GridItem[]>;
  tags: TagInfo[];
  activeTagIds: number[];
  onToggleTagFilter: (id: number) => void;
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
}): React.JSX.Element {
  return (
    <div
      data-testid="rail-tree"
      className={`flex flex-col ${RAIL_SLIDE_FROM_RIGHT}`}
    >
      <GroupHeader
        label={treeLabel}
        variant="trio"
        filterOpen={filterOpen}
        activeFilterCount={activeFilterCount}
        filterLabel={filterLabel}
        onToggleFilter={onToggleFilter}
        onSshConnect={onSshConnect}
        leadingAction={
          <Tooltip label="Add workspace (folder)">
            <button
              type="button"
              aria-label="Add workspace (folder)"
              className={GROUP_ADD_CLS}
              onClick={onAddWorkspace}
            >
              <Icon glyph={IconPlus} role="ui" />
            </button>
          </Tooltip>
        }
      />

      {(
        <nav
          className={`wlist flex flex-col gap-1 p-2 overflow-y-auto ${dragPath !== null ? "cursor-grabbing" : ""}`}
        >
          {filteredWorkspaces.map((w, i) => {
            const all = sessions.filter((s) => s.project_dir === w.path);
            const own = liveCount(all);
            const matched =
              activeTagIds.length > 0
                ? all.filter((s) => tagsOf(s).some((t) => activeTagIds.includes(t)))
                    .length
                : 0;
            const unread = unreadByWs[w.path] ?? 0;
            const owed = owedByWs[w.path] ?? 0;
            const color = colorOf(w.path);
            const on = selected === w.path;
            const grids = gridsByWorkspace[w.path];
            const pinned = pinnedWorkspaces.has(w.path);
            const dropBefore = dropIndex === i &&
              dragPath !== null &&
              dragPath !== w.path && (
                <div className="h-0 mx-2 relative pointer-events-none before:content-[''] before:absolute before:left-0 before:right-0 before:top-[-1px] before:h-0.5 before:rounded-[1px] before:bg-[var(--accent)]" />
              );
            const groupLabel =
              pinnedCount === 0 ? null : i === 0 ? (
                <div key="ws-group-pinned" className={WS_SUBGROUP_LABEL_CLS}>
                  Pinned
                </div>
              ) : i === pinnedCount ? (
                <Fragment key="ws-group-folders">
                  <div
                    data-testid="ws-pinned-divider"
                    role="separator"
                    className={WS_SUBGROUP_RULE_CLS}
                  >
                    <div className="h-px bg-[var(--border)]" />
                  </div>
                  <div className={WS_SUBGROUP_LABEL_CLS}>Folders</div>
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
                    unread={unread}
                    owed={owed}
                    panes={all.length}
                    tagMatched={activeTagIds.length > 0 ? matched : undefined}
                    tagTotal={all.length}
                    live={own}
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
                    unread={unread}
                    owed={owed}
                    panes={all.length}
                    tagMatched={activeTagIds.length > 0 ? matched : undefined}
                    tagTotal={all.length}
                    live={own}
                    pinned={pinned}
                    grids={grids}
                    tags={tags}
                    activeTagIds={activeTagIds}
                    onToggleTagFilter={onToggleTagFilter}
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
                  unread={unread}
                  owed={owed}
                  allCount={all.length}
                  ownCount={own}
                  tagMatched={activeTagIds.length > 0 ? matched : undefined}
                  tagTotal={all.length}
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
            <div className="h-0 mx-2 relative pointer-events-none before:content-[''] before:absolute before:left-0 before:right-0 before:top-[-1px] before:h-0.5 before:rounded-[1px] before:bg-[var(--accent)]" />
          )}
          {filteredWorkspaces.length === 0 && (
            <div className="text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] px-[10px] py-2 leading-[1.5]">
              {workspaces.length === 0
                ? "No workspaces yet. The + above opens a git project folder."
                : activeFilterCount > 0
                  ? `No tab carries ${activeFilterCount === 1 ? "that tag" : "any of those tags"}. Clear the filter from the funnel above.`
                  : "No workspaces match your filter."}
            </div>
          )}
        </nav>
      )}
    </div>
  );
}

export function Sidebar({
  workspaces,
  sessions,
  selected,
  customColors,
  colorIndexByPath,
  unreadByWs,
  owedByWs,
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
  className = "",
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
  const railView = useRailView();
  const hiddenRailViews = useHiddenRailViews();
  const { custom, dataCustom } = useCustomSurface();
  const activeSettingsSection = useSettingsSection();

  const [treeFilter, setTreeFilter] = useState<string | null>(null);
  const filterOpen = tagMenu !== null;
  const filterQuery = (treeFilter ?? "").trim().toLowerCase();
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
      sessionIds: grid.sessionIds ?? [],
      tagIds: grid.tagIds ?? [],
    });
  };

  useEffect(() => {
    localStorage.setItem(TAG_FILTER_KEY, JSON.stringify(activeTagIds));
  }, [activeTagIds]);
  const activeFilterCount = activeTagIds.length;
  const filterLabel = filterLabelFor(activeTagIds.length);

  const tagUsage = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of sessions)
      for (const t of tagsOf(s)) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [sessions]);

  const toggleTagFilter = (id: number): void => {
    setTagFilter((cur) =>
      cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id],
    );
  };

  const addTagFilters = (ids: number[]): void => {
    setTagFilter((cur) => [...cur, ...ids.filter((id) => !cur.includes(id))]);
  };

  const toggleGridTag = (menu: GridCtxMenu, tagId: number): void => {
    if (!menu.tagIds.includes(tagId)) {
      const over = menu.sessionIds.filter((sid) => {
        const s = sessions.find((x) => x.id === sid);
        return (
          s !== undefined &&
          !tagsOf(s).includes(tagId) &&
          tagsOf(s).length >= MAX_TAGS_PER_SESSION
        );
      });
      if (over.length > 0) {
        onOpenExternalError?.(
          `refused: session ${over[0]} already carries ${MAX_TAGS_PER_SESSION} tags (the MAX_TAGS_PER_SESSION cap)`,
        );
        return;
      }
    }
    const next = menu.tagIds.includes(tagId)
      ? menu.tagIds.filter((t) => t !== tagId)
      : [...menu.tagIds, tagId];
    onSetGridTags?.(menu.path, menu.gridId, menu.sessionIds, next);
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
      sessions={sessions}
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

  const settingsGroupRows = SETTINGS_GROUPS.map((g) => ({
    group: g,
    sections: NAVIGABLE_SETTINGS_SECTIONS.filter(
      (s) =>
        s.group === g.id &&
        (!filterQuery ||
          s.label.toLowerCase().includes(filterQuery) ||
          s.keywords.some((k) => k.toLowerCase().includes(filterQuery))),
    ),
  })).filter((g) => g.sections.length > 0);

  return (
    <aside
      data-custom={dataCustom}
      {...materialAttrs("shell")}
      className={`w-full flex-none flex flex-col relative z-[var(--z-leaf)] ${MATERIAL_CLS.shell} ${
        custom ? "shadow-[var(--glass-rail-shadow)]" : ""
      } ${className}`}
    >
      <RailHead
        onHeadMouseDown={onHeadMouseDown}
        onHeadDoubleClick={onHeadDoubleClick}
        onHideRail={onHideRail}
      />
      {}
      <RailNav
        view={railView}
        hidden={hiddenRailViews}
        paletteChord={paletteChord}
        onOpenPalette={onOpenPalette ?? (() => {})}
        onSelect={selectRailView}
        onRowMenu={openNavMenu}
      />
      <div className="railscroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">
        {settingsOpen ? (
          <SettingsTree
            treeFilter={treeFilter}
            setTreeFilter={setTreeFilter}
            settingsGroupRows={settingsGroupRows}
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
            onAddWorkspace={onAddWorkspace}
            selected={selected}
            filteredWorkspaces={filteredWorkspaces}
            workspaces={workspaces}
            pinnedWorkspaces={pinnedWorkspaces}
            pinnedCount={pinnedCount}
            sessions={sessions}
            unreadByWs={unreadByWs}
            owedByWs={owedByWs}
            colorOf={colorOf}
            gridsByWorkspace={gridsByWorkspace}
            tags={tags}
            activeTagIds={activeTagIds}
            onToggleTagFilter={toggleTagFilter}
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
      </div>

      <div className="railfoot py-[var(--space-1-5)] px-[var(--space-3)] flex-none flex items-center gap-[var(--space-1)]">
        {}
        <Tooltip label="Settings">
          <button
            type="button"
            aria-label="Settings"
            aria-pressed={settingsOpen}
            className={`${FOOT_ICON_BTN} ${settingsOpen ? RAIL_SELECTED_CLS : ""}`}
            onClick={onOpenSettings}
          >
            <Icon glyph={IconGear} role="ui" />
          </button>
        </Tooltip>
        <Tooltip label={chromeTheme === "paper" ? "Switch to dark theme" : "Switch to light theme"}>
          <button
            type="button"
            aria-label={chromeTheme === "paper" ? "Switch to dark theme" : "Switch to light theme"}
            className={FOOT_ICON_BTN}
            onClick={onToggleChromeTheme}
          >
            <Icon glyph={chromeTheme === "paper" ? IconSun : IconMoon} role="ui" />
          </button>
        </Tooltip>
        <RailUpdateButton version={updateVersion} />
      </div>

      {portalOrNull(menuEl)}
      {portalOrNull(gridMenuEl)}
      {portalOrNull(navMenuEl)}
      {portalOrNull(tagMenuEl)}
      {portalOrNull(tagEditorEl)}
      {portalOrNull(tagManagerEl)}
    </aside>
  );
}
