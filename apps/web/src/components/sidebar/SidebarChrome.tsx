import { ListChecksIcon, MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { usePullRequestsSupported } from "../../state/environments";
import { useOpenLayoutPage } from "../../layout/pageNavigation";
import { isLayoutPageContent, selectFocusedTab, type LayoutState } from "../../layout/layoutModel";
import { useLayoutStore } from "../../layout/layoutStore";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { cn } from "../../lib/utils";
import { HoustonWordmark } from "../HoustonWordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../../environmentIdentification";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { nextRailThemeMode, railThemeLabel } from "./railTheme";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { observeResize } from "~/lib/observeResize";

/**
 * The rail's brand row: Houston's mark and name, with the sidebar's hide
 * control at the right. It keeps the top bar's height so it lines up with the
 * window controls and the top bar of the pane beside it.
 */
export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isDesktopHost,
  showHideControl = true,
}: {
  isDesktopHost: boolean;
  /** The phone's home is the rail itself, so it has nothing to hide. */
  showHideControl?: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      data-drag-region="deep"
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-2",
        isDesktopHost && "drag-region",
      )}
    >
      <div className="relative z-10 flex h-9 min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <SidebarBrand />
        {pillLabel ? (
          <div className="ml-1 flex h-7 shrink-0 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
      {showHideControl ? (
        <SidebarTrigger
          aria-label="Hide sidebar"
          className="relative z-10 size-7! shrink-0 [-webkit-app-region:no-drag]"
        />
      ) : null}
    </div>
  );
});

export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[calc(var(--workspace-controls-left)-0.75rem)] flex">
        <SidebarBrandMark />
      </div>
    </div>
  );
}

function SidebarBrand() {
  return (
    <Link
      aria-label="Go to threads"
      className="relative z-10 ml-[calc(var(--workspace-controls-left)-0.75rem)] flex h-7 w-fit min-w-0 shrink items-center overflow-hidden rounded-(--control-radius) text-foreground outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset"
      to="/"
    >
      <SidebarBrandMark />
    </Link>
  );
}

function SidebarBrandMark() {
  return (
    <HoustonWordmark
      aria-label="Houston"
      className="min-w-0 gap-2 truncate text-base text-foreground"
      markClassName="size-[22px]"
    />
  );
}

function SidebarUtilityItem({
  icon,
  label,
  tooltip = label,
  active = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  /** The hover label; the name with its shortcut when one opens it. */
  tooltip?: string;
  /** The page this button opens is the one on screen. */
  active?: boolean;
  onClick: (source: Element) => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              aria-current={active ? "page" : undefined}
              isActive={active}
              onClick={(event) => onClick(event.currentTarget)}
              size="icon"
              className="size-7 [&_svg]:size-[15px]"
            >
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

/** The page tab the focused pane shows, if any, so its footer button reads as the current one. */
const selectFocusedPageKind = (state: { layout: LayoutState }) => {
  const content = selectFocusedTab(state.layout)?.content;
  return content !== undefined && isLayoutPageContent(content) ? content.kind : null;
};

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu({
  hideTasks = false,
}: {
  /** The phone's home keeps Pull requests, without the Tasks destination. */
  hideTasks?: boolean;
}) {
  const navigate = useNavigate();
  const openLayoutPage = useOpenLayoutPage();
  const { isMobile, setOpenMobile } = useSidebar();
  const { appearanceMode, setAppearanceMode } = useTheme();
  const pullRequestsSupported = usePullRequestsSupported();
  const focusedPage = useLayoutStore(selectFocusedPageKind);
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const themeLabel = railThemeLabel(appearanceMode);
  const ThemeIcon =
    appearanceMode === "dark" ? MoonIcon : appearanceMode === "light" ? SunIcon : MonitorIcon;
  const cycleTheme = (source: Element) => {
    setAppearanceMode(nextRailThemeMode(appearanceMode), source);
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };
  // A page is a tab: focus the one already open, otherwise add one beside the focused tab.
  const openPage = (kind: "pull-requests" | "tasks") => {
    closeMobileSidebar();
    void openLayoutPage(kind);
  };

  return (
    <SidebarMenu className="flex-row items-center">
      {pullRequestsSupported ? (
        <SidebarUtilityItem
          icon={<PullRequestGlyph.pullRequest />}
          label="Pull requests"
          active={focusedPage === "pull-requests"}
          onClick={() => openPage("pull-requests")}
        />
      ) : null}
      {hideTasks ? null : (
        <SidebarUtilityItem
          icon={<ListChecksIcon />}
          label="Tasks"
          active={focusedPage === "tasks"}
          onClick={() => openPage("tasks")}
        />
      )}
      <li aria-hidden className="min-w-0 flex-1" />
      <SidebarUtilityItem
        icon={<ThemeIcon />}
        label={`Theme: ${themeLabel}`}
        onClick={cycleTheme}
      />
      <SidebarUtilityItem icon={<SettingsIcon />} label="Settings" onClick={handleSettingsClick} />
      <SidebarThreadUndoNotice />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  hideTasks = false,
}: {
  hideTasks?: boolean;
}) {
  return (
    <SidebarFooter className="mt-auto">
      <SidebarUpdatePill />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu hideTasks={hideTasks} />
    </SidebarFooter>
  );
});
