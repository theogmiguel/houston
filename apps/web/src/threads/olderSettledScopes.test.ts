import { EnvironmentId, ProjectId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { olderSettledScopesForProjects } from "./olderSettledScopes";

const env = (id: string) => EnvironmentId.make(id);
const project = (id: string) => ProjectId.make(id);

describe("olderSettledScopesForProjects", () => {
  it("groups the listed projects by environment without repeats", () => {
    expect(
      olderSettledScopesForProjects([
        { environmentId: env("a"), id: project("p1") },
        { environmentId: env("b"), id: project("p2") },
        { environmentId: env("a"), id: project("p3") },
        { environmentId: env("a"), id: project("p1") },
      ]),
    ).toEqual([
      { environmentId: "a", projectIds: ["p1", "p3"] },
      { environmentId: "b", projectIds: ["p2"] },
    ]);
  });

  it("has no scope when no project is listed", () => {
    expect(olderSettledScopesForProjects([])).toEqual([]);
  });
});
