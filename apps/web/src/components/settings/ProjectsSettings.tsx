import { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon, LayersIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";
import { useEnvironments } from "../../state/environments";

export function ProjectsSettings() {
  const { search: value, scope, selectScope } = useSettingsScope();
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const overrideCount = (group: (typeof groups)[number]) => {
    let count = 0;
    for (const member of group.memberProjects) {
      const environment = environments.find(
        (candidate) => candidate.environmentId === member.environmentId,
      );
      const overrides = environment?.serverConfig?.settings.projectSettingsOverrides?.[member.id];
      if (!overrides) continue;
      count += Object.values(overrides).filter(
        (overrideValue) => overrideValue !== null && overrideValue !== undefined,
      ).length;
    }
    return count;
  };
  const openProject = (projectKey: string) =>
    selectScope({ project: projectKey, machine: undefined, checkout: undefined });
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              Show all environments
            </Button>
          ) : null}
        </div>
      </SettingsPageContainer>
    ) : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  const actionProject = groups[0] ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <SettingsPageContainer>
          <SettingsSection
            id="projects"
            title="Projects"
            footer={
              <p className="px-1 text-xs leading-4 text-muted-foreground">
                A project's settings override the defaults marked with the layers icon. A
                houston.json in the repository overrides both.
              </p>
            }
          >
            {groups.map((group) => {
              const count = overrideCount(group);
              return (
                <SettingsRow
                  key={group.projectKey}
                  title={group.displayName}
                  description={
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {group.memberProjects[0]?.workspaceRoot ?? ""}
                    </span>
                  }
                  control={
                    <div className="flex w-full items-center justify-end gap-2">
                      <span className="text-xs text-muted-foreground">
                        {count === 0
                          ? "No overrides"
                          : `${count} ${count === 1 ? "override" : "overrides"}`}
                      </span>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`${group.displayName} settings`}
                        onClick={() => openProject(group.projectKey)}
                      >
                        <ChevronRightIcon className="size-3.5" />
                      </Button>
                    </div>
                  }
                />
              );
            })}
          </SettingsSection>
          <SettingsSection id="project-actions-defaults" title="Actions">
            <SettingsRow
              title="Actions"
              description="Commands a project can run from the thread header, such as dev, test and lint."
              control={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={actionProject === null}
                  onClick={() => {
                    if (actionProject) openProject(actionProject.projectKey);
                  }}
                >
                  {actionProject ? `Edit for ${actionProject.displayName}` : "Edit"}
                </Button>
              }
            />
          </SettingsSection>
        </SettingsPageContainer>
      )}
    </div>
  );
}
