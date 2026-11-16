import { ProjectId } from "@houston-app/contracts";
import type {
  HoustonMergeQueueEntry,
  HoustonMergeQueueSnapshot,
} from "@houston-app/contracts/houston/mergeQueue";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { MergeQueueList } from "./MergeQueueList";

const PROJECT = ProjectId.make("project-1");
const NOW = Date.parse("2026-11-03T18:00:00.000Z");

function entry(overrides: Partial<HoustonMergeQueueEntry>): HoustonMergeQueueEntry {
  return {
    projectId: PROJECT,
    number: 1,
    repository: "owner/repository",
    url: "https://github.com/owner/repository/pull/1",
    title: "A pull request",
    headRef: "houston/branch",
    headSha: "9d2e7b4a1c2d3e4f5061728394a5b6c7d8e9f0a1",
    baseRef: "main",
    dependsOn: null,
    ownerThreadId: null,
    position: 1,
    status: "ready",
    reason: null,
    gates: [],
    verification: null,
    failure: null,
    github: null,
    enqueuedAt: "2026-11-03T13:00:00.000Z",
    readAt: null,
    verifyingSince: null,
    ...overrides,
  };
}

const SNAPSHOT: HoustonMergeQueueSnapshot = {
  projectId: PROJECT,
  entries: [
    entry({ number: 482, title: "Fix flaky sync timer test", position: 1 }),
    entry({
      number: 471,
      title: "Rename grid dialog",
      position: 2,
      status: "blocked",
      reason: "2 unresolved review threads",
    }),
    entry({
      number: 468,
      title: "Migrate settings store to sqlite",
      position: 0,
      status: "parked",
      reason: "Timed out after 30m",
    }),
  ],
  log: [
    {
      id: 1,
      kind: "merge",
      number: 476,
      repository: "owner/repository",
      url: "https://github.com/owner/repository/pull/476",
      title: "Bump the usage poll interval",
      refName: "main",
      oldSha: "7c20de1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      newSha: "b81d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "b81d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      forkSha: null,
      method: "squash",
      detail: null,
      unattended: false,
      at: new Date(NOW).toISOString(),
    },
  ],
  settings: {
    projectId: PROJECT,
    mergeWhenVerified: false,
    verificationCommand: "pnpm test:ci",
    timeLimitMinutes: 30,
    paused: false,
    revision: 1,
  },
  globalPaused: false,
  away: { merged: 0, parked: 0 },
  handOff: null,
  message: null,
};

it("renders the line, parked and today rows in the pull request row shape", async () => {
  const onSelectEntry = vi.fn();
  const onRevert = vi.fn();
  await using screen = await render(
    <MergeQueueList
      snapshot={SNAPSHOT}
      now={NOW}
      selectedKey={`${PROJECT}:482`}
      onSelectEntry={onSelectEntry}
      onSelectLog={() => {}}
      onRevert={onRevert}
      revertingNumber={null}
    />,
  );

  await expect.element(screen.getByText("In line", { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText("Ready", { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText("2 unresolved review threads")).toBeInTheDocument();
  await expect.element(screen.getByText("Timed out after 30m")).toBeInTheDocument();
  await expect.element(screen.getByText("Merged into main@b81d0aa · squash")).toBeInTheDocument();

  await screen.getByRole("button", { name: /#482 Fix flaky sync timer test/ }).click();
  expect(onSelectEntry).toHaveBeenCalledWith(expect.objectContaining({ number: 482 }));

  await page.getByRole("button", { name: "Revert" }).click();
  expect(onRevert).toHaveBeenCalledWith(476);
});
