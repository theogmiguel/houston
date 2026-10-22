import { Suspense, lazy, useContext, useEffect, useRef } from "react";
import type { PrInfo } from "../../houston/client";
import { KeymapOverridesContext } from "../../layout/keymapOverridesContext";
import { closeWorkspaceShortcut, effectiveLabel, renameWorkspaceShortcut } from "../../keymap";
import { gridStorageKey } from "../../layout/tree";
import { RAIL_VIEW_LABEL, type RailView } from "../../railView";
import { showItemInFolder } from "../../houston/bridge";
import { openWorkspaceTransfer } from "../../houston/transferOpen";
import {
  IconArrowUpRight,
  IconChevronRight,
  IconClose,
  IconCodeXml,
  IconEyeOff,
  IconFileDown,
  IconFolder,
  IconGrid,
  IconPencil,
  IconPin,
  IconPlus,
  IconTag,
} from "../icons";
import { OpenInMenu } from "../OpenInMenu";
import { Icon } from "../ui/Icon";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuHeading,
  ContextMenuItems,
  ContextMenuSeparator,
} from "../ui/ContextMenu";
import { usePointerMenuPosition } from "../ui/usePointerMenuPosition";
import { GridRailContextActions } from "../ui/GridRailContextActions";
import { RailContextMenu, RailMenuValue } from "../ui/rail/RailChrome";
import { useTagPopover } from "../tags/TagPopover";

const GridRailExtraActions = lazy(() => import("../ui/GridRailExtraActions").then((module) => ({ default: module.GridRailExtraActions })));

export interface CtxMenu {
  x: number;
  y: number;
  path: string;
  name: string;
  color: string;
  pinned: boolean;
  /** True when this is the selected workspace, the one the F2 and close shortcuts act on. */
  selected: boolean;
}

export interface GridCtxMenu {
  x: number;
  y: number;
  originX: number;
  originY: number;
  path: string;
  gridId: string;
  name: string;
  canRemove: boolean;
  pinned: boolean;
  userNamed: boolean;
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

// Focuses the first enabled item on open and gives focus back to the opener when the menu goes away.
function useMenuFocus(menuRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLElement>(".ctx-item:not(:disabled)")?.focus();
    return () => {
      if (previous?.isConnected && document.activeElement === document.body) previous.focus();
    };
  }, [menuRef]);
}

export function WorkspaceContextMenu({
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
  const keymapOverrides = useContext(KeymapOverridesContext);
  const menuRef = useRef<HTMLDivElement>(null);
  const position = usePointerMenuPosition(menuRef, menu.x, menu.y);
  useMenuFocus(menuRef);
  // The shortcuts act on the selected workspace, so another workspace's menu does not advertise them.
  const hint = (entry: typeof renameWorkspaceShortcut): React.JSX.Element | null =>
    menu.selected && keymapOverrides.shortcuts_enabled ? <kbd>{effectiveLabel(entry, keymapOverrides)}</kbd> : null;
  return (
    <ContextMenu
      ref={menuRef}
      className=""
      style={{
        top: position.top,
        left: position.left,
        ["--pop-origin-x" as string]: `${menu.x - position.left}px`,
        ["--pop-origin-y" as string]: `${menu.y - position.top}px`,
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
          {hint(renameWorkspaceShortcut)}
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
        <ContextMenuItem
          role="menuitem"
          data-testid="ws-transfer-export"
          onClick={() => {
            const { path, name } = menu;
            onClose();
            openWorkspaceTransfer({ mode: "export", workspace: path, name });
          }}
        >
          <Icon glyph={IconArrowUpRight} role="ui" />
          <span>Export transfer…</span>
        </ContextMenuItem>
        <ContextMenuItem
          role="menuitem"
          data-testid="ws-transfer-import"
          onClick={() => {
            const { path } = menu;
            onClose();
            openWorkspaceTransfer({ mode: "import", workspace: path });
          }}
        >
          <Icon glyph={IconFileDown} role="ui" />
          <span>Import transfer…</span>
        </ContextMenuItem>
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
          {hint(closeWorkspaceShortcut)}
        </ContextMenuItem>
      </ContextMenuItems>
    </ContextMenu>
  );
}

export function GridContextMenu({
  gridMenu,
  onClose,
  onOpenGrid,
  onStartRename,
  onResetName,
  onRemoveGrid,
  onTogglePin,
  onOpenInspector,
  onError,
}: {
  gridMenu: GridCtxMenu;
  onClose: () => void;
  onOpenGrid?: (path: string, gridId: string) => void;
  onStartRename: (path: string, gridId: string) => void;
  onResetName?: (path: string, gridId: string) => void;
  onRemoveGrid?: (path: string, gridId: string) => void;
  onTogglePin: (path: string, gridId: string) => void;
  onOpenInspector?: (paneId: number, tab: "pull-request") => void;
  onError?: (message: string) => void;
}): React.JSX.Element {
  const tagPopover = useTagPopover();
  const menuRef = useRef<HTMLDivElement>(null);
  const position = usePointerMenuPosition(menuRef, gridMenu.x, gridMenu.y);
  const tagsHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTags = (anchor: HTMLElement): void => {
    if (tagsHoverTimer.current) clearTimeout(tagsHoverTimer.current);
    tagsHoverTimer.current = null;
    tagPopover.open({ anchor, gridId: gridStorageKey(gridMenu.path, gridMenu.gridId), view: 'pick', placement: 'right', onDismiss: onClose });
  };
  useMenuFocus(menuRef);
  useEffect(() => () => {
    if (tagsHoverTimer.current) clearTimeout(tagsHoverTimer.current);
  }, []);
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
        {gridMenu.userNamed && onResetName && <ContextMenuItem role="menuitem" data-testid="menu-grid-reset-name" onClick={() => {
          onResetName(gridMenu.path, gridMenu.gridId);
          onClose();
        }}>
          <Icon glyph={IconPencil} role="ui" />
          <span>Reset to automatic name</span>
        </ContextMenuItem>}
        <ContextMenuItem role="menuitem" data-testid="menu-grid-pin" onClick={() => { onTogglePin(gridMenu.path, gridMenu.gridId); onClose() }}>
          <Icon glyph={IconPin} role="ui" />
          <span>{gridMenu.pinned ? "Unpin" : "Pin to top"}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem role="menuitem" aria-haspopup="dialog" data-testid="menu-tags-entry"
          onClick={(event) => openTags(event.currentTarget)}
          onPointerEnter={(event) => {
            const anchor = event.currentTarget;
            if (tagsHoverTimer.current) clearTimeout(tagsHoverTimer.current);
            // A short delay keeps a pointer passing over the entry from opening the picker.
            tagsHoverTimer.current = setTimeout(() => openTags(anchor), 200);
          }}
          onPointerLeave={() => {
            if (tagsHoverTimer.current) clearTimeout(tagsHoverTimer.current);
            tagsHoverTimer.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            openTags(event.currentTarget);
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
        {gridMenu.canRemove && <>
          <ContextMenuSeparator />
          <ContextMenuItem danger role="menuitem" onClick={() => {
            const { path, gridId } = gridMenu;
            onClose();
            onRemoveGrid?.(path, gridId);
          }}>
            <Icon glyph={IconClose} role="ui" />
            <span>{gridMenu.agentCount > 0 ? `Close grid and its ${gridMenu.agentCount} ${gridMenu.agentCount === 1 ? "agent" : "agents"}…` : "Close grid"}</span>
          </ContextMenuItem>
        </>}
      </ContextMenuItems>
    </RailContextMenu>
  );
}

export function NavViewMenu({
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
