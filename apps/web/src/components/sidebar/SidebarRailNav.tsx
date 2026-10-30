import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
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

export function SidebarRailActionRow({
  icon,
  label,
  trailing,
  active = false,
  disabled = false,
  tooltip,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  tooltip?: ReactNode;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const row = (
    <button
      type="button"
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-(--control-radius) px-2 text-left text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50",
        active
          ? "bg-sidebar-row-selected text-sidebar-foreground"
          : "text-secondary-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
      )}
    >
      <span className="inline-grid size-[15px] shrink-0 place-items-center text-secondary-label [&>svg]:size-[15px]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
  if (tooltip === undefined) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="right">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarRailSectionHeading({ actions }: { actions?: ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 px-2 pt-3 text-2xs leading-3.5 font-semibold tracking-wide text-secondary-label">
      <span className="flex-1">Workspaces</span>
      {actions}
      <button
        type="button"
        aria-label="Add project"
        onClick={() => openCommandPalette({ open: "add-project" })}
        className="-my-1.5 inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-(--control-radius) text-secondary-label transition-colors outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <PlusIcon aria-hidden className="size-[15px]" />
      </button>
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
      className="flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-(--control-radius) bg-sidebar-row-hover px-2 text-left text-sm text-secondary-foreground transition-colors outline-none hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <SearchIcon aria-hidden className="size-[15px] shrink-0 text-secondary-label" />
      <span className="min-w-0 flex-1 truncate">Search</span>
      {shortcut ? <SidebarRailKbd>{shortcut}</SidebarRailKbd> : null}
    </button>
  );
}

/**
 * The rail's fixed entries, shared by the thread and grid sidebars: search,
 * pull requests, usage, then the Workspaces heading with add. Ctrl N still
 * starts a thread, but the row is gone: new threads start from a grid's +.
 */
export function SidebarRailNav({
  search,
  workspaceActions,
  pullRequestCount = null,
}: {
  search: ReactNode;
  workspaceActions?: ReactNode;
  pullRequestCount?: number | null;
}) {
  const navigate = useNavigate();
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
  const openUsage = () => {
    closeMobileSidebar();
    void navigate({ to: "/usage" });
  };

  return (
    <div className="flex flex-col gap-px">
      {search}
      {pullRequestsSupported ? (
        <SidebarRailActionRow
          icon={<PullRequestGlyph.pullRequest />}
          label="Pull requests"
          active={pathname === "/pull-requests"}
          trailing={
            pullRequestCount !== null ? (
              <span className="shrink-0 text-xs text-secondary-label tabular-nums">
                {pullRequestCount}
              </span>
            ) : null
          }
          onClick={openPullRequests}
        />
      ) : null}
      <SidebarRailActionRow
        icon={<ChartNoAxesColumnIcon />}
        label="Usage"
        active={pathname === "/usage"}
        onClick={openUsage}
      />
      <SidebarRailSectionHeading actions={workspaceActions} />
    </div>
  );
}
