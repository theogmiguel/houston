import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "../orchestrationV2.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchWorkspaceStrategy);

describe("a worktree launch strategy", () => {
  it("keeps decoding without repositoryKeys, as older clients send it", () => {
    expect(decode({ type: "worktree", baseRef: "origin/main", startFromOrigin: true })).toEqual({
      type: "worktree",
      baseRef: "origin/main",
      startFromOrigin: true,
    });
  });

  it("decodes the repositories a task folder should check out", () => {
    expect(
      decode({
        type: "worktree",
        baseRef: "origin/main",
        repositoryKeys: ["api", "web"],
      }),
    ).toEqual({ type: "worktree", baseRef: "origin/main", repositoryKeys: ["api", "web"] });
  });
});
