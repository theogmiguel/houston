import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultProjectRef } from "./useHandleNewThread";

describe("resolveDefaultProjectRef", () => {
  it("does not choose the scratch project over a real project", () => {
    expect(
      resolveDefaultProjectRef(
        [
          {
            id: "project-scratch",
            environmentId: "environment-primary",
            workspaceRoot: "/scratch",
            archivedAt: null,
            isScratch: true,
          },
          {
            id: "project-real",
            environmentId: "environment-primary",
            workspaceRoot: "/real",
            archivedAt: null,
          },
        ] as never,
        [],
      ),
    ).toEqual({ environmentId: "environment-primary", projectId: "project-real" });
  });
});
