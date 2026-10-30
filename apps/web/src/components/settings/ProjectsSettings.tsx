import { EnvironmentId } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";

export function ProjectsSettings() {
  const { search: value, scope, selectScope } = useSettingsScope();
  const groups = useSettingsProjectGroups();
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
          <SettingsSection id="projects" title="Projects">
            {groups.map((group) => (
              <SettingsRow
                key={group.projectKey}
                title={group.displayName}
                description={group.memberProjects
                  .map((member) => member.workspaceRoot)
                  .filter(Boolean)
                  .join(" · ")}
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      selectScope({
                        project: group.projectKey,
                        machine: undefined,
                        checkout: undefined,
                      })
                    }
                  >
                    Open
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        </SettingsPageContainer>
      )}
    </div>
  );
}
