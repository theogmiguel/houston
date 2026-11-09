import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, ListChecksIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { openAddProjectDialog } from "../AddProjectDialog";
import { openCommandPalette } from "../../commandPaletteBus";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { MOTION_FEEDBACK } from "../ui/motion-recipes";
import {
  RAIL_SHORTCUT_ACTIVE_CLS,
  RAIL_SHORTCUT_CLS,
  RAIL_SHORTCUT_ICON_ACTIVE_CLS,
  RAIL_SHORTCUT_ICON_CLS,
  RAIL_SHORTCUT_ICON_REST_CLS,
  RAIL_SHORTCUT_REST_CLS,
} from "../ui/sidebar-rail-recipes";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A board kbd chip: 16px tall, one hairline border, 11px tabular ink. */
export function SidebarRailKbd({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded-(--r-badge) border border-sidebar-border px-1.5 text-2xs font-medium whitespace-nowrap text-secondary-label">
      {children}
    </span>
  );
}

/**
 * One icon-only shortcut of the rail's shortcut row, the active route filled and marked with
 * `aria-current`. The name is the accessible name and the tooltip, with the shortcut when one
 * opens it.
 */
function SidebarRailShortcut({
  icon,
  label,
  active,
  shortcut = null,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  shortcut?: string | null;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            data-rail-shortcut={label}
            onClick={onClick}
            className={cn(
              RAIL_SHORTCUT_CLS,
              MOTION_FEEDBACK,
              active ? RAIL_SHORTCUT_ACTIVE_CLS : RAIL_SHORTCUT_REST_CLS,
            )}
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            RAIL_SHORTCUT_ICON_CLS,
            active ? RAIL_SHORTCUT_ICON_ACTIVE_CLS : RAIL_SHORTCUT_ICON_REST_CLS,
          )}
        >
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {shortcut === null ? label : `${label} · ${shortcut}`}
      </TooltipPopup>
    </Tooltip>
  );
}

export function SidebarRailSectionHeading({
  title = "Workspaces",
  actions,
  showAddProject = true,
}: {
  title?: string | undefined;
  actions?: ReactNode;
  showAddProject?: boolean;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 px-2 pt-3 text-2xs leading-3.5 font-semibold tracking-wide text-secondary-label">
      <span className="flex-1">{title}</span>
      {actions}
      {showAddProject ? (
        <button
          type="button"
          aria-label="Add project"
          onClick={() => openAddProjectDialog()}
          className={cn(
            "-my-1.5 inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-(--control-radius) text-secondary-label outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            MOTION_FEEDBACK,
          )}
        >
          <PlusIcon aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** The rail's search entry when the sidebar has no inline filter of its own. */
export function SidebarRailSearchButton() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  return (
    <button
      type="button"
      onClick={() => openCommandPalette()}
      className={cn(
        "flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-(--control-radius) bg-sidebar-row-hover px-2 text-left text-sm text-secondary-foreground outline-none hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        MOTION_FEEDBACK,
      )}
    >
      <SearchIcon aria-hidden className="size-4 shrink-0 text-secondary-label" />
      <span className="min-w-0 flex-1 truncate">Search</span>
      {shortcut ? <SidebarRailKbd>{shortcut}</SidebarRailKbd> : null}
    </button>
  );
}

/**
 * The rail's fixed entries, shared by the thread and grid sidebars: search, one row of icon
 * buttons for pull requests, tasks and usage, then a section heading whose title and actions the
 * caller owns. Ctrl N still starts a thread, but the row is gone.
 */
export function SidebarRailNav({
  search,
  sectionTitle,
  sectionActions,
  sectionAddProject = true,
  sectionHeading = true,
  hideTasks = false,
}: {
  search: ReactNode;
  sectionTitle?: string;
  sectionActions?: ReactNode;
  sectionAddProject?: boolean;
  /** A rail that draws its own project sections drops the shared heading row. */
  sectionHeading?: boolean;
  /** The phone's home keeps Pull requests and Usage, without the Tasks destination. */
  hideTasks?: boolean;
}) {
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const usageShortcut = shortcutLabelForCommand(keybindings, "usage.open");
  const pullRequestsSupported = usePullRequestsSupported();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const openPullRequests = () => {
    closeMobileSidebar();
    void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
  };
  const openTasks = () => {
    closeMobileSidebar();
    void navigate({ to: "/tasks" });
  };
  const openUsage = () => {
    closeMobileSidebar();
    void navigate({ to: "/usage" });
  };

  return (
    <div className="flex flex-col gap-px">
      {search}
      <div data-rail-shortcuts="" className="flex gap-0.5">
        {pullRequestsSupported ? (
          <SidebarRailShortcut
            icon={<PullRequestGlyph.pullRequest />}
            label="Pull requests"
            active={pathname === "/pull-requests"}
            onClick={openPullRequests}
          />
        ) : null}
        {hideTasks ? null : (
          <SidebarRailShortcut
            icon={<ListChecksIcon />}
            label="Tasks"
            active={pathname === "/tasks"}
            onClick={openTasks}
          />
        )}
        <SidebarRailShortcut
          icon={<ChartNoAxesColumnIcon />}
          label="Usage"
          shortcut={usageShortcut}
          active={pathname === "/usage"}
          onClick={openUsage}
        />
      </div>
      {sectionHeading ? (
        <SidebarRailSectionHeading
          title={sectionTitle}
          actions={sectionActions}
          showAddProject={sectionAddProject}
        />
      ) : null}
    </div>
  );
}
