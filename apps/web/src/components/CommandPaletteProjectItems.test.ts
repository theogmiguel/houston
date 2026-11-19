import { EnvironmentId, ProjectId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CommandPaletteProject } from "./CommandPalette.logic";
import { buildProjectSearchItems } from "./CommandPaletteProjectItems";

describe("project search rows", () => {
  const environmentId = EnvironmentId.make("local");
  const base = {
    environmentId,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;

  it("leaves the No project scratch folder out of project rows", () => {
    const scratch = {
      ...base,
      id: ProjectId.make("scratch"),
      title: "No project",
      workspaceRoot: "/home/user/.houston/v2/scratch",
      isScratch: true,
      displayName: "No project",
    } as CommandPaletteProject;
    const real = {
      ...base,
      id: ProjectId.make("atlas"),
      title: "atlas-api",
      workspaceRoot: "/work/atlas-api",
      displayName: "atlas-api",
    } as CommandPaletteProject;

    const items = buildProjectSearchItems({
      projects: [scratch, real],
      projectGroupByTargetKey: new Map(),
      locationByEnvironmentId: new Map(),
      runProject: async () => {},
      isScratch: (project) => project.isScratch === true,
    });

    expect(items.map((item) => item.value)).toEqual([`project:${environmentId}:${real.id}`]);
  });
});
