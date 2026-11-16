import { EnvironmentId, ProjectId } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarProjectFolderHeader } from "./SidebarProjectFolderHeader";

const environmentId = EnvironmentId.make("env-1");

const group: SidebarProjectSnapshot = {
  id: ProjectId.make("project-1"),
  environmentId,
  title: "Houston",
  workspaceRoot: "/repos/houston",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  projectKey: "env-1:/repos/houston",
  displayName: "Houston",
  groupedProjectCount: 1,
  environmentPresence: "local-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  memberProjects: [],
  memberProjectRefs: [],
  remoteEnvironmentLabels: [],
  pinned: false,
  archived: false,
};

it("turns the chevron and reveals its action on their motion roles", async () => {
  await using screen = await render(
    <ul>
      <SidebarProjectFolderHeader
        group={group}
        collapsed={false}
        hiddenThreads={[]}
        onToggle={() => {}}
        onNewThread={() => {}}
        onContextMenu={() => {}}
      />
    </ul>,
    { router: false },
  );

  const chevron = getComputedStyle(screen.container.querySelector("button > svg")!);
  expect(chevron.transitionProperty).toContain("transform");
  expect(chevron.transitionDuration).toBe("0.2s");
  expect(chevron.transitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0, 1)");

  const reveal = [...screen.container.querySelectorAll<HTMLElement>("span")].find((span) =>
    span.className.includes("right-6"),
  );
  if (reveal === undefined) throw new Error("The folder header has no action reveal span.");
  const revealStyle = getComputedStyle(reveal);
  expect(revealStyle.transitionProperty).toBe("opacity");
  expect(revealStyle.transitionDuration).toBe("0.1s");
  expect(revealStyle.transitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0, 1)");
});
