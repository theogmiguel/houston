import type { EnvironmentId, EnvironmentMachineKind } from "@houston-app/contracts";
import { CheckIcon, FolderIcon, ListFilterIcon, SettingsIcon } from "lucide-react";
import { createContext, useContext, type MouseEvent as ReactMouseEvent } from "react";

import { nextProjectFilterKeys } from "../../grid/projectFilter";
import { cn } from "../../lib/utils";
import {
  projectGroupsSpanEnvironments,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SIDEBAR_SECTION_ACTION_CLS } from "../ui/sidebar-grids";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ThreadProjectFilter {
  readonly label: string;
  readonly isActive: boolean;
  readonly onToggle: () => void;
}

/** Lets a thread's menu offer Filter by project without every row knowing the filter. */
export const ProjectFilterContext = createContext<
  ((workspace: { environmentId: string; projectId: string }) => ThreadProjectFilter | null) | null
>(null);

export function useThreadProjectFilter(workspace: {
  environmentId: string;
  projectId: string;
}): ThreadProjectFilter | null {
  return useContext(ProjectFilterContext)?.(workspace) ?? null;
}

/**
 * The rail header's project filter. A click chooses one project and Shift-click
 * adds more; right-clicking a project, or its gear, opens its settings.
 */
export function ProjectFilterPicker({
  groups,
  activeKeys,
  primaryEnvironmentId,
  machineByEnvironmentId,
  onChange,
  onOpenSettings,
}: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  activeKeys: ReadonlyArray<string>;
  primaryEnvironmentId: EnvironmentId | null;
  machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  onChange: (keys: string[]) => void;
  onOpenSettings: (group: SidebarProjectSnapshot) => void;
}) {
  const showEnvironments = projectGroupsSpanEnvironments(groups);
  const filtered = activeKeys.length > 0;
  const chosenNames = groups
    .filter((group) => activeKeys.includes(group.projectKey))
    .map((group) => group.displayName);
  const label = filtered ? `Filter by project: ${chosenNames.join(", ")}` : "Filter by project";
  const choose = (key: string | null, event: ReactMouseEvent) => {
    onChange(nextProjectFilterKeys(activeKeys, key, event.shiftKey));
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  data-project-filter={filtered ? "active" : "off"}
                  className={cn(
                    SIDEBAR_SECTION_ACTION_CLS,
                    "relative",
                    filtered && "text-(--accent-ink)",
                  )}
                />
              }
            />
          }
        >
          <ListFilterIcon aria-hidden className="size-[15px]" />
          {filtered ? (
            <span
              aria-hidden
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-(--accent-ink)"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end" className="max-w-72">
        <MenuItem
          closeOnClick={false}
          aria-checked={!filtered}
          onClick={(event) => choose(null, event)}
        >
          <FolderIcon aria-hidden className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">All projects</span>
          {filtered ? null : <CheckIcon aria-hidden className="size-3.5" />}
        </MenuItem>
        <MenuSeparator />
        {groups.map((group) => {
          const selected = activeKeys.includes(group.projectKey);
          return (
            <MenuItem
              key={group.projectKey}
              closeOnClick={false}
              aria-checked={selected}
              data-project-filter-item={group.projectKey}
              onClick={(event) => choose(group.projectKey, event)}
              onContextMenu={(event) => {
                event.preventDefault();
                onOpenSettings(group);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                event.preventDefault();
                onOpenSettings(group);
              }}
            >
              <span className="grid size-3.5 shrink-0 place-items-center">
                {selected ? <CheckIcon aria-hidden className="size-3.5" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
              {showEnvironments ? (
                <ProjectEnvironmentBadge
                  group={group}
                  primaryEnvironmentId={primaryEnvironmentId}
                  machineByEnvironmentId={machineByEnvironmentId}
                />
              ) : null}
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Project settings for ${group.displayName}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenSettings(group);
                }}
                className="ml-auto inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label hover:bg-(--sel) hover:text-foreground"
              >
                <SettingsIcon aria-hidden className="size-3.5" />
              </button>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
