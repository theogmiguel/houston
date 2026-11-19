import { derivePhysicalProjectKey } from "@houston-app/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@houston-app/client-runtime/state/shell";
import type { EnvironmentId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspaceNewThreadTarget } from "./useHandleNewThread";

const environmentId = "env-1" as EnvironmentId;

function project(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    id,
    environmentId,
    title: id,
    workspaceRoot,
    archivedAt: null,
    ...overrides,
  } as unknown as EnvironmentProject;
}

describe("resolveWorkspaceNewThreadTarget", () => {
  it("picks the most recent real project, skipping scratch and archived projects", () => {
    const real = project("real", "/work/real");
    const scratch = project("scratch", "/scratch", { isScratch: true });
    const archived = project("archived", "/work/archived", {
      archivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      resolveWorkspaceNewThreadTarget({
        projects: [real, scratch, archived],
        projectOrder: [
          derivePhysicalProjectKey(scratch),
          derivePhysicalProjectKey(archived),
          derivePhysicalProjectKey(real),
        ],
        scratchEnvironmentId: environmentId,
      }),
    ).toEqual({
      kind: "project",
      projectRef: { environmentId, projectId: "real" },
    });
  });

  it("opens a scratch draft when every project is scratch", () => {
    const scratch = project("scratch", "/scratch", { isScratch: true });

    expect(
      resolveWorkspaceNewThreadTarget({
        projects: [scratch],
        projectOrder: [derivePhysicalProjectKey(scratch)],
        scratchEnvironmentId: environmentId,
      }),
    ).toEqual({ kind: "scratch", environmentId });
  });

  it("opens a scratch draft when there are no projects", () => {
    expect(
      resolveWorkspaceNewThreadTarget({
        projects: [],
        projectOrder: [],
        scratchEnvironmentId: environmentId,
      }),
    ).toEqual({ kind: "scratch", environmentId });
  });

  it("has no target when there is neither a project nor a scratch root", () => {
    expect(
      resolveWorkspaceNewThreadTarget({
        projects: [],
        projectOrder: [],
        scratchEnvironmentId: null,
      }),
    ).toBeNull();
  });
});
