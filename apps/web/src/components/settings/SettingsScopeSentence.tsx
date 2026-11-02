import { useLocation } from "@tanstack/react-router";
import { ChevronDownIcon, FolderIcon, LaptopIcon, LayersIcon, ServerIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSearchInput,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";

export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/diffs",
  "/settings/keybindings",
  "/settings/snap-shot",
  "/settings/connections",
  // Network access and authorized clients belong to the environment serving this app.
  "/settings/access",
  "/settings/about",
]);

const SCOPE_TRIGGER_CLS =
  "h-auto min-h-0 min-w-0 max-w-72 justify-start gap-1 px-1 py-0 text-[15px] leading-[22px] font-semibold text-foreground hover:bg-hover sm:text-[15px]";
const SCOPE_TRIGGER_ICON_CLS = "size-3.5 shrink-0 text-muted-foreground";
const SCOPE_SECONDARY_CLS = "text-xs text-muted-foreground";
const SCOPE_PATH_CLS = `${SCOPE_SECONDARY_CLS} font-mono`;
const SCOPE_OFFLINE_CLS = SCOPE_SECONDARY_CLS;

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly singleEnvironment: boolean;
  readonly onChange: (next: SettingsScopeSearch) => void;
}

export function SettingsScopeSentence() {
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  if (scope === null) return null;
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) {
    return (
      <p className="text-muted-foreground">
        <span className="font-semibold text-foreground">App-wide.</span> These settings apply to the
        app on this machine, not to a project.
      </p>
    );
  }
  const props: SettingsScopeMenuProps = {
    value: scope.search,
    singleEnvironment: scope.singleEnvironment,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[15px] leading-[22px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0">Applying settings for</span>
        <ProjectScopeMenu {...props} />
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0">
          {scope.search.machine || scope.scope.kind === "checkout" ? "on" : "across"}
        </span>
        <EnvironmentScopeMenu {...props} />
      </span>
    </p>
  );
}

interface ScopeOption {
  value: string;
  label: string;
  secondary?: string | undefined;
  secondaryMono?: boolean | undefined;
  offline?: boolean | undefined;
}

function ScopeTrigger({
  ariaLabel,
  label,
  icon,
  offline,
}: {
  ariaLabel: string;
  label: string;
  icon: ReactNode;
  offline?: boolean | undefined;
}) {
  return (
    <MenuTrigger
      aria-label={`${ariaLabel}: ${label}`}
      render={<Button variant="ghost" size="sm" />}
      className={SCOPE_TRIGGER_CLS}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {offline ? <span className={SCOPE_OFFLINE_CLS}>Offline</span> : null}
      <ChevronDownIcon aria-hidden className={SCOPE_TRIGGER_ICON_CLS} />
    </MenuTrigger>
  );
}

function ScopeOptionLabel({ option }: { option: ScopeOption }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{option.label}</span>
      {option.secondary ? (
        <span className={option.secondaryMono ? SCOPE_PATH_CLS : SCOPE_SECONDARY_CLS}>
          {option.secondary}
        </span>
      ) : null}
    </span>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  value,
  options,
  allOption,
  searchLabel,
  onChange,
  offline,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  value: string;
  options: ScopeOption[];
  allOption: ScopeOption | null;
  searchLabel: string;
  onChange: (next: string) => void;
  offline?: boolean | undefined;
}) {
  const [query, setQuery] = useState("");
  const choices = allOption ? [allOption, ...options] : options;
  const searchable = choices.length > 8;
  const needle = query.trim().toLowerCase();
  const visible = searchable
    ? choices.filter((option) =>
        `${option.label} ${option.secondary ?? ""} ${option.value}`.toLowerCase().includes(needle),
      )
    : choices;
  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <ScopeTrigger ariaLabel={ariaLabel} label={label} icon={icon} offline={offline} />
      <MenuPopup align="start" className={searchable ? "w-80" : undefined}>
        <div className="w-72 max-w-full">
          {searchable ? (
            <MenuSearchInput
              autoFocus
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          ) : null}
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            {visible.length === 0 ? <MenuItem disabled>No matches found.</MenuItem> : null}
            {visible.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <ScopeOptionLabel option={option} />
                  {option.offline ? <span className={SCOPE_OFFLINE_CLS}>Offline</span> : null}
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  singleEnvironment,
}: SettingsScopeMenuProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const resolved = resolveSettingsScope(value, groups, environments);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selected = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  const primary = selected?.environmentId === primaryEnvironmentId;
  const project = groups.find((group) => group.projectKey === value.project);
  const memberEnvironmentIds = project
    ? new Set(project.memberProjects.map((member) => member.environmentId))
    : null;
  const options = memberEnvironmentIds
    ? environments.filter((environment) => memberEnvironmentIds.has(environment.environmentId))
    : environments;
  return (
    <ScopeMenu
      ariaLabel="Environment scope"
      icon={
        selected === undefined ? (
          <LayersIcon aria-hidden className={SCOPE_TRIGGER_ICON_CLS} />
        ) : primary ? (
          <LaptopIcon aria-hidden className={SCOPE_TRIGGER_ICON_CLS} />
        ) : (
          <ServerIcon aria-hidden className={SCOPE_TRIGGER_ICON_CLS} />
        )
      }
      label={
        selected
          ? settingsScopeEnvironmentLabel(selected, environments)
          : environmentValue !== ALL_ENVIRONMENTS_VALUE
            ? "Unavailable environment"
            : singleEnvironment
              ? "No environments"
              : "All environments"
      }
      value={environmentValue}
      onChange={(next) => onChange(selectEnvironmentAxis(value, next))}
      searchLabel="Search environments"
      offline={selected !== undefined && selected.connection.phase !== "connected"}
      allOption={
        singleEnvironment
          ? null
          : {
              value: ALL_ENVIRONMENTS_VALUE,
              label: "All environments",
              secondary: "Every connected machine",
            }
      }
      options={options.map((environment) => {
        const { primary: label } = settingsScopeEnvironmentLabels(environment, environments);
        const isPrimary = environment.environmentId === primaryEnvironmentId;
        return {
          value: environment.environmentId,
          label,
          secondary: isPrimary
            ? "This machine"
            : settingsScopeEnvironmentLabels(environment, environments).secondary ||
              settingsScopeEnvironmentAddress(environment),
          offline: environment.connection.phase !== "connected",
        };
      })}
    />
  );
}

function ProjectScopeMenu({ value, groups, environments, onChange }: SettingsScopeMenuProps) {
  const selected = groups.find((group) => group.projectKey === value.project);
  const projects = projectScopeMenuGroups(groups, value).map((group) => ({
    group,
    machines: settingsScopeProjectMachines(group, environments, true).join(", "),
  }));
  return (
    <ScopeMenu
      ariaLabel="Project scope"
      icon={<FolderIcon aria-hidden className={SCOPE_TRIGGER_ICON_CLS} />}
      label={selected?.displayName ?? (value.project ? "Unavailable project" : "All projects")}
      value={projectAxisValue(value)}
      onChange={(next) => onChange(selectProjectAxis(value, next))}
      searchLabel="Search projects"
      allOption={{ value: ALL_PROJECTS_VALUE, label: "All projects" }}
      options={projects.map(({ group, machines }) => {
        const sameName = projects.filter(
          (other) =>
            other.group.projectKey !== group.projectKey &&
            other.group.displayName === group.displayName,
        );
        const secondary =
          sameName.length === 0
            ? undefined
            : sameName.some((other) => other.machines === machines)
              ? `${machines} · ${group.workspaceRoot}`
              : machines;
        return {
          value: group.projectKey,
          label: group.displayName,
          secondary: group.archived
            ? ["Archived", secondary].filter(Boolean).join(" · ")
            : secondary,
          secondaryMono: secondary?.includes(group.workspaceRoot) ?? false,
        };
      })}
    />
  );
}
