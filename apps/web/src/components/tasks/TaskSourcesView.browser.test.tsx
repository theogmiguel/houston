import type {
  HoustonTaskSourceConflictEntry,
  HoustonTaskSourceSettings,
} from "@houston-app/contracts/houston/taskSources";
import type { HoustonSlackInfo, HoustonSlackRequest } from "@houston-app/contracts/houston/slack";
import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";
import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly value: unknown }>,
  projectId: "p1",
  tasks: [] as HoustonTaskSummary[],
  settings: [] as HoustonTaskSourceSettings[],
  conflicts: [] as HoustonTaskSourceConflictEntry[],
  slackInfo: null as HoustonSlackInfo | null,
  slackRequests: [] as HoustonSlackRequest[],
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: { readonly __value?: unknown }) => atom.__value,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly __label?: string }) => async (value: unknown) => {
    fixture.calls.push({ command: command.__label ?? "unknown", value });
    return { _tag: "Success", value: fixture.conflicts[0]?.link ?? null };
  },
}));

vi.mock("~/state/tasks", () => ({ refreshTaskDetail: () => undefined }));

vi.mock("~/state/taskSources", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    taskSourcesEnvironment: {
      settings: () => ({ __value: AsyncResult.success(fixture.settings) }),
      conflicts: () => ({ __value: AsyncResult.success(fixture.conflicts) }),
      saveSettings: { __label: "saveSettings" },
      syncNow: { __label: "syncNow" },
      resolve: { __label: "resolve" },
    },
  };
});

vi.mock("~/state/slack", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    slackEnvironment: {
      info: () => ({ __value: AsyncResult.success(fixture.slackInfo) }),
      requests: () => ({ __value: AsyncResult.success(fixture.slackRequests) }),
    },
  };
});

vi.mock("~/localApi", () => ({ readLocalApi: () => undefined }));

import { render } from "../../../test/render";
import { TaskSourcesView } from "./TaskSourcesView";

const PROJECT = { id: "p1", title: "Houston" };

function task(overrides: Partial<HoustonTaskSummary> = {}): HoustonTaskSummary {
  return {
    id: 161,
    number: 161,
    key: "HOU-161",
    projectId: "p1" as never,
    title: "Add dark mode to the usage chart",
    status: "todo",
    priority: "none",
    parentId: null,
    refUrl: null,
    revision: 3,
    createdBy: "slack",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    acceptanceChecked: 0,
    acceptanceTotal: 0,
    domainKind: null,
    queue: "none",
    ready: false,
    openRun: null,
    ...overrides,
  };
}

function settings(provider: "github_issues" | "notion"): HoustonTaskSourceSettings {
  return {
    projectId: "p1" as never,
    provider,
    enabled: true,
    revision: 2,
    githubRepository: provider === "github_issues" ? "theogmiguel/houston" : null,
    githubLabel: "houston-ready",
    githubAssignedUser: null,
    notionDataSourceId: provider === "notion" ? "8f3a-c21e" : null,
    notionTitlePropertyId: null,
    notionDescriptionPropertyId: null,
    notionStatusPropertyId: null,
    notionAssigneePropertyId: null,
    notionProjectRelationPropertyId: null,
    notionAssigneeUserId: "b17d-90aa",
    notionActiveStatusValues: ["Todo", "In progress"],
    notionProjectsDataSourceId: null,
    notionProjectTitlePropertyId: null,
    notionProjectDescriptionPropertyId: null,
    notionPrUrlPropertyId: null,
    notionStatusMapping: {
      todo: null,
      inProgress: null,
      inReview: null,
      done: null,
      canceled: null,
    },
    hasCredential: provider === "notion",
    lastSyncAt: "2026-01-01T00:00:00.000Z",
    lastError: provider === "notion" ? "Token rejected (401)" : null,
  };
}

function conflict(fields: ReadonlyArray<string>): HoustonTaskSourceConflictEntry {
  return {
    taskId: 142,
    taskKey: "HOU-142",
    taskTitle: "Retry failed webhook deliveries",
    taskRevision: 4,
    initiativeRevision: 2,
    link: {
      taskId: 142,
      projectId: "p1" as never,
      provider: "notion",
      externalId: "page-142",
      url: "https://notion.so/page-142",
      source: "source",
      remoteRev: "remote-1",
      bodyHash: "hash",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      syncedAt: "2026-01-01T00:00:00.000Z",
      snapshot: {
        base: { title: "Retry failed webhooks" },
        local: { title: "Retry failed webhook deliveries" },
        remote: { title: "Retry webhook deliveries with backoff" },
        conflicts: fields.map((field) => ({
          field,
          base: "Last agreed",
          local: "Houston value",
          remote: "Notion value",
        })),
        revision: 5,
        projectExternalId: "project-1",
        project: null,
      },
      syncState: { state: "diverged" },
    },
  };
}

function reset() {
  fixture.calls = [];
  fixture.tasks = [task()];
  fixture.settings = [settings("github_issues"), settings("notion")];
  fixture.conflicts = [conflict(["title", "status"])];
  fixture.slackInfo = {
    enabled: true,
    hasTokens: true,
    connection: "connected",
    team: "cdv-eng",
    botUserId: "U01",
    ownerUserId: "U04H2K9QZ",
    channels: [{ channelId: "C07A1B2CD", projectId: "p1" as never }],
    language: "en",
    lastEventAt: "2026-01-01T00:00:00.000Z",
    lastCatchupAt: null,
    error: null,
    revision: 1,
  };
  fixture.slackRequests = [
    {
      taskId: 161,
      projectId: "p1" as never,
      author: "maria",
      channelId: "C07A1B2CD",
      state: "pending",
      permalink: "https://slack.com/archives/C07A1B2CD/p1",
      statusReaction: null,
    },
  ];
}

it("lists conflicts, source status and Slack requests for one workspace", async () => {
  reset();
  await using screen = await render(
    <TaskSourcesView
      environmentId={"env" as never}
      projects={[PROJECT]}
      tasks={fixture.tasks}
      projectId="p1"
      onProjectChange={() => undefined}
      onOpenTask={() => undefined}
    />,
  );

  expect(screen.container.textContent).toContain("HOU-142");
  expect(screen.container.textContent).toContain("Notion · title and status differ");
  expect(screen.container.textContent).toContain("GitHub issues");
  expect(screen.container.textContent).toContain("theogmiguel/houston");
  expect(screen.container.textContent).toContain("Token rejected (401)");
  expect(screen.container.textContent).toContain("Awaiting approval");
  expect(screen.container.textContent).toContain("@maria in C07A1B2CD");
});

it("opens the task whose conflict needs a decision", async () => {
  reset();
  const opened: string[] = [];
  await using screen = await render(
    <TaskSourcesView
      environmentId={"env" as never}
      projects={[PROJECT]}
      tasks={fixture.tasks}
      projectId="p1"
      onProjectChange={() => undefined}
      onOpenTask={(taskKey) => opened.push(taskKey)}
    />,
  );

  await screen.getByRole("button", { name: "Resolve" }).first().click();

  expect(opened).toEqual(["HOU-142"]);
});

it("shows the empty states when nothing is connected or filed", async () => {
  reset();
  fixture.conflicts = [];
  fixture.slackInfo = {
    ...fixture.slackInfo,
    enabled: false,
    team: null,
    channels: [],
    lastEventAt: null,
  } as HoustonSlackInfo;
  fixture.slackRequests = [];
  await using screen = await render(
    <TaskSourcesView
      environmentId={"env" as never}
      projects={[PROJECT]}
      tasks={fixture.tasks}
      projectId="p1"
      onProjectChange={() => undefined}
      onOpenTask={() => undefined}
    />,
  );

  expect(screen.container.textContent).toContain("Houston and every connected source agree.");
  expect(screen.container.textContent).toContain("No Slack requests yet");
  expect(screen.container.textContent).toContain("Connect Slack");
});
