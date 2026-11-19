import { derivePhysicalProjectKey } from "@houston-app/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@houston-app/client-runtime/state/shell";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { ProjectId, type EnvironmentId } from "@houston-app/contracts";
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

  it("uses the project of the focused thread or draft over the most recent project", () => {
    const recent = project("recent", "/work/recent");
    const focused = project("focused", "/work/focused");

    expect(
      resolveWorkspaceNewThreadTarget({
        projects: [recent, focused],
        projectOrder: [derivePhysicalProjectKey(recent), derivePhysicalProjectKey(focused)],
        focusedProjectRef: scopeProjectRef(environmentId, focused.id),
        scratchEnvironmentId: environmentId,
      }),
    ).toEqual({
      kind: "project",
      projectRef: { environmentId, projectId: "focused" },
    });
  });

  it("falls back to the most recent real project when the focused project is scratch", () => {
    const recent = project("recent", "/work/recent");
    const scratch = project("scratch", "/scratch", { isScratch: true });

    expect(
      resolveWorkspaceNewThreadTarget({
        projects: [recent, scratch],
        projectOrder: [derivePhysicalProjectKey(recent), derivePhysicalProjectKey(scratch)],
        focusedProjectRef: scopeProjectRef(environmentId, scratch.id),
        scratchEnvironmentId: environmentId,
      }),
    ).toEqual({
      kind: "project",
      projectRef: { environmentId, projectId: "recent" },
    });
  });

  it("falls back to the most recent real project when the focused project is archived or gone", () => {
    const recent = project("recent", "/work/recent");
    const archived = project("archived", "/work/archived", {
      archivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      resolveWorkspaceNewThreadTarget({
        projects: [recent, archived],
        projectOrder: [derivePhysicalProjectKey(recent), derivePhysicalProjectKey(archived)],
        focusedProjectRef: scopeProjectRef(environmentId, archived.id),
        scratchEnvironmentId: environmentId,
      }),
    ).toEqual({
      kind: "project",
      projectRef: { environmentId, projectId: "recent" },
    });
    expect(
      resolveWorkspaceNewThreadTarget({
        projects: [recent],
        projectOrder: [derivePhysicalProjectKey(recent)],
        focusedProjectRef: scopeProjectRef(environmentId, ProjectId.make("missing")),
        scratchEnvironmentId: environmentId,
      }),
    ).toEqual({
      kind: "project",
      projectRef: { environmentId, projectId: "recent" },
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
