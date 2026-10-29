import { ArrowLeftIcon, LayoutGridIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useGridStore, workspaceKeyOf } from "../../grid/gridStore";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { toastManager } from "../ui/toast";
import { HoustonWordmark } from "../HoustonWordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
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
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode,
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-2",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
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
        <SidebarBrandMark onBackdrop={false} />
      </div>
    </div>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[calc(var(--workspace-controls-left)-0.75rem)] flex h-7 w-fit min-w-0 shrink items-center overflow-hidden rounded-(--control-radius) outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandMark onBackdrop={onBackdrop} />
    </Link>
  );
}

function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <HoustonWordmark
      aria-label="Houston"
      className={cn("min-w-0 truncate text-sm", onBackdrop ? "text-white/70" : "text-foreground")}
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
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const projects = useProjects();
  const grids = useGridStore((state) => state.grids);
  const createGrid = useGridStore((state) => state.createGrid);
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handleGridsClick = () => {
    closeMobileSidebar();
    const last = grids.at(-1);
    if (last !== undefined) {
      void navigate({ to: "/grid/$gridId", params: { gridId: last.id } });
      return;
    }
    const project = projects[0];
    if (project === undefined) {
      toastManager.add({
        type: "info",
        title: "Open a project to create its first grid",
        description: "A grid holds threads from one project's workspace.",
      });
      return;
    }
    const gridId = createGrid({
      environmentId: project.environmentId,
      projectId: project.id,
      workspaceKey: workspaceKeyOf(project.environmentId, project.id),
    });
    void navigate({ to: "/grid/$gridId", params: { gridId } });
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
          <SidebarUtilityItem icon={<LayoutGridIcon />} label="Grids" onClick={handleGridsClick} />
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
        </>
      )}
      <SidebarThreadUndoNotice />
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="mt-auto">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
