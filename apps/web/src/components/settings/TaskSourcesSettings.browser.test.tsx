import type { HoustonSlackInfo } from "@houston-app/contracts/houston/slack";
import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly value: unknown }>,
  slackInfo: null as HoustonSlackInfo | null,
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

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map((environment) => environment.environmentId)),
}));

vi.mock("~/state/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/projects")>()),
  environmentProjects: {
    ...(await importOriginal<typeof import("~/state/projects")>()).environmentProjects,
    projectsAtom: { __value: [{ id: "p1", title: "Houston", environmentId: "env" }] },
  },
}));

vi.mock("~/localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/localApi")>()),
  readLocalApi: () => undefined,
}));

vi.mock("~/state/v1Import", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    v1IssueImportStatus: () => ({ __value: AsyncResult.success({ state: "unavailable" }) }),
    v1IssueImportRun: { __label: "importIssues" },
  };
});

vi.mock("~/state/slack", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    slackEnvironment: {
      info: () => ({ __value: AsyncResult.success(fixture.slackInfo) }),
      requests: () => ({ __value: AsyncResult.success([]) }),
      importStatus: () => ({ __value: AsyncResult.success({ state: "unavailable" }) }),
      connect: { __label: "connect" },
      disconnect: { __label: "disconnect" },
      configure: { __label: "configure" },
      importRun: { __label: "importSlack" },
    },
  };
});

import { render } from "../../../test/render";
import { TaskSourcesSettingsPanel } from "./TaskSourcesSettings";

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

it("shows the connected Slack workspace and saves its configuration", async () => {
  fixture.calls = [];
  fixture.slackInfo = SLACK_INFO;
  await using screen = await render(<TaskSourcesSettingsPanel />);

  expect(screen.container.textContent).toContain("cdv-eng");
  await expect.element(screen.getByLabelText("Channel 1")).toHaveValue("C07A1B2CD");
  expect(screen.container.textContent).toContain("Notion pages are issues on the Issues page");
  await screen.getByRole("button", { name: "Save" }).click();

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
  fixture.calls = [];
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
