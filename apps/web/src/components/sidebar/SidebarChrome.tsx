import { ArrowLeftIcon, MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { HoustonWordmark } from "../HoustonWordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
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
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
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
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      data-tauri-drag-region="deep"
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-2",
        isElectron && "drag-region",
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
      <SidebarTrigger
        aria-label="Hide sidebar"
        className="relative z-10 size-7! shrink-0 [-webkit-app-region:no-drag] [&_svg]:size-[15px]"
      />
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
      className="min-w-0 gap-2 truncate text-sm text-foreground"
      markClassName="size-[18px]"
    />
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              onClick={onClick}
              size="icon"
              className="size-7 [&_svg]:size-[15px]"
            >
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const { appearanceMode, setAppearanceMode } = useTheme();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const themeLabel = railThemeLabel(appearanceMode);
  const ThemeIcon =
    appearanceMode === "dark" ? MoonIcon : appearanceMode === "light" ? SunIcon : MonitorIcon;
  const cycleTheme = () => {
    setAppearanceMode(nextRailThemeMode(appearanceMode));
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };
  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          <SidebarUtilityItem
            icon={<ThemeIcon />}
            label={`Theme: ${themeLabel}`}
            onClick={cycleTheme}
          />
        </>
      )}
      <SidebarThreadUndoNotice />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="mt-auto">
      <SidebarUpdatePill />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
