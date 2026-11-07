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
  openPullRequest?: boolean;
}): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make(options.id),
    title: options.title,
    providerInstanceId,
    updatedAt: options.updatedAt,
    latestUserMessageAt: options.updatedAt,
    hasPendingUserInput: options.needsInput ?? false,
    runtime:
      options.status === "running"
        ? {
            status: "running",
            activeRunId: RunId.make("run"),
            providerInstanceId,
            providerName: "Codex",
            lastError: null,
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
        <DraftProjectContext
          branch="main"
          checkoutLabel="Local checkout"
          threads={threads}
          onOpenThread={onOpenThread}
        />
      </div>
    </TooltipProvider>,
  );
}

const running = thread({
  id: "running",
  title: "Sync exchange rates for the quarter",
  updatedAt: "2026-11-06T09:50:00.000Z",
  status: "running",
});
const needsInput = thread({
  id: "input",
  title: "Pick a date format for export",
  updatedAt: "2026-11-06T09:40:00.000Z",
  needsInput: true,
  openPullRequest: true,
});
const older = thread({
  id: "older",
  title: "Parse negative amounts",
  updatedAt: "2026-11-05T09:00:00.000Z",
});
const oldest = thread({
  id: "oldest",
  title: "Rebuild the search index",
  updatedAt: "2026-11-01T09:00:00.000Z",
});

it("states the checkout, the attention counts, open pull requests and the three newest threads", async () => {
  await using screen = await context([oldest, older, needsInput, running]);

  await expect.element(screen.getByText("main")).toBeVisible();
  await expect.element(screen.getByText(/Local checkout/)).toBeVisible();
  await expect.element(screen.getByText(/1 open pull request/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^Open running:/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^Open needs input:/ })).toBeVisible();
  await expect.element(screen.getByText("Sync exchange rates for the quarter")).toBeVisible();
  await expect.element(screen.getByText("Pick a date format for export")).toBeVisible();
  await expect.element(screen.getByText("Parse negative amounts")).toBeVisible();
  expect(screen.getByText("Rebuild the search index").query()).toBeNull();
});

it("opens the first thread behind a count and any listed thread", async () => {
  const onOpenThread = vi.fn();
  await using screen = await context([oldest, older, needsInput, running], onOpenThread);

  await userEvent.click(screen.getByRole("button", { name: /^Open running:/ }).element());
  expect(onOpenThread).toHaveBeenLastCalledWith(
    expect.objectContaining({ environmentId, threadId: ThreadId.make("running") }),
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Open thread: Pick a date format for export" }).element(),
  );
  expect(onOpenThread).toHaveBeenLastCalledWith(
    expect.objectContaining({ environmentId, threadId: ThreadId.make("input") }),
  );
});
