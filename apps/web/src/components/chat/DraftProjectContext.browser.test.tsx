import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { makeThreadFixture } from "../../test-fixtures";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { DraftProjectContext } from "./DraftProjectContext";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const providerInstanceId = ProviderInstanceId.make("codex");

function thread(options: {
  id: string;
  title: string;
  updatedAt: string;
  status?: "running" | "idle";
  needsInput?: boolean;
  needsApproval?: boolean;
  failed?: boolean;
  settleUnseenAt?: string;
  openPullRequest?: boolean;
}): EnvironmentThreadShell {
  const runtimeBase = {
    providerInstanceId,
    providerName: "Codex",
    lastError: null,
  } as const;
  return makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make(options.id),
    title: options.title,
    providerInstanceId,
    updatedAt: options.updatedAt,
    latestUserMessageAt: options.updatedAt,
    hasPendingUserInput: options.needsInput ?? false,
    hasPendingApprovals: options.needsApproval ?? false,
    lastVisitedAt: "2026-10-01T00:00:00.000Z",
    ...(options.settleUnseenAt === undefined ? {} : { unsettledAt: options.settleUnseenAt }),
    latestRun: options.failed
      ? {
          runId: RunId.make("failed-run"),
          status: "failed",
          requestedAt: options.updatedAt,
          startedAt: options.updatedAt,
          completedAt: options.updatedAt,
          assistantMessageId: null,
        }
      : null,
    runtime:
      options.status === "running"
        ? {
            ...runtimeBase,
            status: "running",
            activeRunId: RunId.make("run"),
            updatedAt: options.updatedAt,
          }
        : options.failed
          ? {
              ...runtimeBase,
              status: "failed",
              activeRunId: null,
              updatedAt: options.updatedAt,
            }
          : null,
    ...(options.openPullRequest
      ? {
          pullRequests: [
            {
              host: "github.com",
              repository: "acme/atlas-api",
              number: 42,
              url: "https://github.com/acme/atlas-api/pull/42",
              source: "agent",
              linkedAt: options.updatedAt,
              stack: null,
              snapshot: {
                title: "Add retry hints",
                state: "open",
                isDraft: false,
                headBranch: "retry-hints",
                baseBranch: "main",
                updatedAt: options.updatedAt,
                syncedAt: options.updatedAt,
              },
            },
          ],
        }
      : {}),
  });
}

function context(threads: ReadonlyArray<EnvironmentThreadShell>, onOpenThread = vi.fn()) {
  return render(
    <TooltipProvider delay={0}>
      <div style={{ width: 720 }}>
        <DraftProjectContext threads={threads} onOpenThread={onOpenThread} />
      </div>
    </TooltipProvider>,
  );
}

function rowTitles(screen: Awaited<ReturnType<typeof context>>): string[] {
  return Array.from(screen.container.querySelectorAll("[data-draft-project-context] li")).map(
    (row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
}

const input = thread({
  id: "input",
  title: "Pick a date format for export",
  updatedAt: "2026-11-06T09:40:00.000Z",
  needsInput: true,
});
const failed = thread({
  id: "failed",
  title: "Rebuild the search index",
  updatedAt: "2026-11-05T09:00:00.000Z",
  failed: true,
});
const back = thread({
  id: "back",
  title: "Add a --month filter to the report",
  updatedAt: "2026-11-04T09:00:00.000Z",
  settleUnseenAt: "2026-11-04T09:30:00.000Z",
});
const running = thread({
  id: "running",
  title: "Sync exchange rates for the quarter",
  updatedAt: "2026-11-06T09:50:00.000Z",
  status: "running",
});
const runningOlder = thread({
  id: "running-older",
  title: "Stream CSV imports into the warehouse",
  updatedAt: "2026-11-05T08:00:00.000Z",
  status: "running",
});
const openPr = thread({
  id: "open-pr",
  title: "Approve writing the generated report",
  updatedAt: "2026-11-03T09:00:00.000Z",
  openPullRequest: true,
});
const idle = thread({
  id: "idle",
  title: "Investigate intermittent ECONNRESET errors",
  updatedAt: "2026-11-02T09:00:00.000Z",
});

it("states the attention counts as filter chips and lists attention before running and the rest", async () => {
  await using screen = await context([idle, openPr, runningOlder, running, back, failed, input]);

  await expect.element(screen.getByRole("button", { name: /2 running/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /1 needs input/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /1 open PR/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /needs approval/ }).query()).toBeNull();

  expect(rowTitles(screen)).toEqual([
    expect.stringContaining("Pick a date format for export"),
    expect.stringContaining("Rebuild the search index"),
    expect.stringContaining("Add a --month filter to the report"),
  ]);
});

it("filters the list to a pressed chip and clears it on a second press", async () => {
  await using screen = await context([idle, openPr, runningOlder, running, back, failed, input]);

  const runningChip = screen.getByRole("button", { name: /2 running/ });
  await userEvent.click(runningChip.element());
  expect(runningChip.element().getAttribute("aria-pressed")).toBe("true");
  expect(rowTitles(screen)).toEqual([
    expect.stringContaining("Sync exchange rates for the quarter"),
    expect.stringContaining("Stream CSV imports into the warehouse"),
  ]);

  await userEvent.click(runningChip.element());
  expect(runningChip.element().getAttribute("aria-pressed")).toBe("false");
  expect(rowTitles(screen)).toHaveLength(3);

  await userEvent.click(screen.getByRole("button", { name: /1 open PR/ }).element());
  expect(rowTitles(screen)).toEqual([
    expect.stringContaining("Approve writing the generated report"),
  ]);
});

it("draws a status glyph on every row, including a quiet thread", async () => {
  await using screen = await context([idle, running, input]);

  const rows = Array.from(screen.container.querySelectorAll("[data-draft-project-context] li"));
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.querySelector("[data-status-kind]")).not.toBeNull();
  }
});

it("opens a listed thread", async () => {
  const onOpenThread = vi.fn();
  await using screen = await context([input], onOpenThread);

  await userEvent.click(
    screen.getByRole("button", { name: "Open thread: Pick a date format for export" }).element(),
  );
  expect(onOpenThread).toHaveBeenLastCalledWith(
    expect.objectContaining({ environmentId, threadId: ThreadId.make("input") }),
  );
});

it("renders nothing for a project without threads", async () => {
  await using screen = await context([]);
  expect(screen.container.querySelector("[data-draft-project-context]")).toBeNull();
});
