import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { usePullRequestSurfaceDrag } from "./surfaceDrag";

const state = vi.hoisted(() => ({
  target: null as null | { environmentId: string; input: unknown },
}));
vi.mock("../lib/openPullRequestLink", () => ({
  usePullRequestPreviewTarget: () => state.target,
}));

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));

function Probe() {
  const drag = usePullRequestSurfaceDrag({
    threadRef,
    environmentId: EnvironmentId.make("local"),
    url: "https://github.com/acme/app/pull/42",
  });
  return <span data-drag={drag.onPointerDown === undefined ? "no" : "yes"} />;
}

describe("pull request surface drag availability", () => {
  it("offers no drag when the launcher cannot open the pull request", async () => {
    state.target = null;
    await using screen = await render(<Probe />, { router: false });
    expect(screen.container.querySelector("[data-drag]")?.getAttribute("data-drag")).toBe("no");
  });

  it("offers the drag when the pull request resolves to a project", async () => {
    state.target = {
      environmentId: "local",
      input: { projectId: "project", repository: "acme/app", number: 42 },
    };
    await using screen = await render(<Probe />, { router: false });
    expect(screen.container.querySelector("[data-drag]")?.getAttribute("data-drag")).toBe("yes");
  });
});
