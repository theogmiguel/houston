import type {
  HoustonTaskSourceConflictEntry,
  HoustonTaskSourceSettings,
} from "@houston-app/contracts/houston/taskSources";
import type { HoustonSlackInfo, HoustonSlackRequest } from "@houston-app/contracts/houston/slack";
import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly value: unknown }>,
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
    return { _tag: "Success", value: fixture.slackInfo };
  },
}));

vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => "env",
  usePrimaryEnvironment: () => ({
    environmentId: "env",
    label: "This machine",
    displayUrl: null,
  }),
  useEnvironments: () => ({
    isReady: true,
    networkStatus: null,
    environments: [],
    presentationById: new Map(),
  }),
}));

vi.mock("~/state/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/projects")>()),
  environmentProjects: {
    ...(await importOriginal<typeof import("~/state/projects")>()).environmentProjects,
    projectsAtom: { __value: [{ id: "p1", title: "Houston", environmentId: "env" }] },
  },
}));

vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettingsAvailable: () => true,
}));

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map((environment) => environment.environmentId)),
}));

vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useServerConfigs: () => new Map(),
}));

vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useClearScopedSettings: () => () => undefined,
  useClearProjectOverrides: () => () => undefined,
}));

vi.mock("~/localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/localApi")>()),
  readLocalApi: () => undefined,
}));

vi.mock("~/state/taskSources", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    taskSourcesEnvironment: {
      settings: () => ({ __value: AsyncResult.success(fixture.settings) }),
      conflicts: () => ({ __value: AsyncResult.success(fixture.conflicts) }),
      importStatus: () => ({
        __value: AsyncResult.success({ state: "unavailable" }),
      }),
      saveSettings: { __label: "saveSettings" },
      syncNow: { __label: "syncNow" },
      resolve: { __label: "resolve" },
      setCredential: { __label: "setCredential" },
      clearCredential: { __label: "clearCredential" },
      importRun: { __label: "importSources" },
    },
  };
});

vi.mock("~/state/slack", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    slackEnvironment: {
      info: () => ({ __value: AsyncResult.success(fixture.slackInfo) }),
      requests: () => ({ __value: AsyncResult.success(fixture.slackRequests) }),
      importStatus: () => ({
        __value: AsyncResult.success({ state: "unavailable" }),
      }),
      connect: { __label: "connect" },
      disconnect: { __label: "disconnect" },
      configure: { __label: "configure" },
      importRun: { __label: "importSlack" },
    },
  };
});

import { render } from "../../../test/render";
import { TaskSourcesSettingsPanel } from "./TaskSourcesSettings";

const settings = (provider: "github_issues" | "notion"): HoustonTaskSourceSettings => ({
  projectId: "p1" as never,
  provider,
  enabled: true,
  revision: 2,
  githubRepository: provider === "github_issues" ? "theogmiguel/houston" : null,
  githubLabel: "houston-ready",
  githubAssignedUser: "theo",
  notionDataSourceId: provider === "notion" ? "8f3a-c21e" : null,
  notionTitlePropertyId: null,
  notionDescriptionPropertyId: null,
  notionStatusPropertyId: null,
  notionAssigneePropertyId: null,
  notionProjectRelationPropertyId: null,
  notionAssigneeUserId: "b17d-90aa",
  notionActiveStatusValues: ["Todo"],
  notionProjectsDataSourceId: null,
  notionProjectTitlePropertyId: null,
  notionProjectDescriptionPropertyId: null,
  notionPrUrlPropertyId: null,
  notionStatusMapping: {
    todo: "Todo",
    inProgress: null,
    inReview: null,
    done: "Done",
    canceled: null,
  },
  hasCredential: provider === "notion",
  lastSyncAt: "2026-01-01T00:00:00.000Z",
  lastError: null,
});

const SLACK_INFO: HoustonSlackInfo = {
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
  revision: 3,
};

function reset(): void {
  fixture.calls = [];
  fixture.settings = [settings("github_issues"), settings("notion")];
  fixture.conflicts = [];
  fixture.slackInfo = SLACK_INFO;
  fixture.slackRequests = [];
}

it("shows the connected Slack workspace and saves its configuration", async () => {
  reset();
  await using screen = await render(<TaskSourcesSettingsPanel />);

  expect(screen.container.textContent).toContain("cdv-eng");
  await expect.element(screen.getByLabelText("Channel 1")).toHaveValue("C07A1B2CD");
  await expect
    .element(screen.getByLabelText("GitHub repository"))
    .toHaveValue("theogmiguel/houston");
  expect(screen.container.textContent).toContain("In keychain");

  await screen.getByRole("button", { name: "Save" }).first().click();
  expect(fixture.calls).toContainEqual({
    command: "configure",
    value: {
      environmentId: "env",
      input: {
        expectedRevision: 3,
        ownerUserId: "U04H2K9QZ",
        channels: [{ channelId: "C07A1B2CD", projectId: "p1" }],
        language: "en",
      },
    },
  });
});

it("starts Slack from both tokens and waits for them before connecting", async () => {
  reset();
  fixture.slackInfo = {
    ...SLACK_INFO,
    enabled: false,
    hasTokens: false,
    team: null,
    channels: [],
    lastEventAt: null,
  };
  await using screen = await render(<TaskSourcesSettingsPanel />);

  expect(screen.container.textContent).toContain("Slack app");
  const connect = screen.getByRole("button", { name: "Connect" });
  await expect.element(connect).toBeDisabled();

  await screen.getByLabelText("App-level token (starts with xapp-)").fill("xapp-1");
  await screen.getByLabelText("Bot token (starts with xoxb-)").fill("xoxb-1");
  await expect.element(connect).toBeEnabled();
  await connect.click();

  expect(fixture.calls).toContainEqual({
    command: "connect",
    value: {
      environmentId: "env",
      input: { appToken: expect.anything(), botToken: expect.anything() },
    },
  });
});

it("counts tracker conflicts and links to the Sources tab", async () => {
  reset();
  fixture.conflicts = [
    {
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
        remoteRev: null,
        bodyHash: null,
        fetchedAt: null,
        syncedAt: null,
        snapshot: {
          base: {},
          local: {},
          remote: {},
          conflicts: [{ field: "title", base: "", local: "a", remote: "b" }],
          revision: 5,
          projectExternalId: null,
          project: null,
        },
        syncState: { state: "diverged" },
      },
    },
  ];
  await using screen = await render(<TaskSourcesSettingsPanel />);

  expect(screen.container.textContent).toContain(
    "1 task changed in both Houston and a tracker. Choose which value to keep on each task.",
  );
  expect(screen.container.textContent).toContain("Review in Tasks");
});
