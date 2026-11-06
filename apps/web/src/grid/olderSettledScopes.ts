import type { OlderSettledScope } from "@houston-app/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@houston-app/contracts";

/**
 * The Closed shelf's scope per environment: the projects the rail lists there. An environment
 * with none of them is left out, so a project filter limits which older threads load.
 */
export function olderSettledScopesForProjects(
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
): OlderSettledScope[] {
  const byEnvironment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    const ids = byEnvironment.get(project.environmentId) ?? [];
    if (!ids.includes(project.id)) ids.push(project.id);
    byEnvironment.set(project.environmentId, ids);
  }
  return [...byEnvironment].map(([environmentId, projectIds]) => ({ environmentId, projectIds }));
}
