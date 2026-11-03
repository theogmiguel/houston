import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTrayPayload, trayConnection, trayThreadKey } from "./tray";

function thread(
  overrides: {
    readonly id: string;
    readonly environmentId: string;
  } & Record<string, unknown>,
): EnvironmentThreadShell {
  return {
    projectId: "project-1" as ProjectId,
    title: "Refactor auth",
    providerInstanceId: "claude" as ProviderInstanceId,
    lineage: { relationshipToParent: null, sideChat: false },
    latestRun: { status: "completed" },
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    blockedOnThreadWait: false,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
    id: overrides.id as ThreadId,
    environmentId: overrides.environmentId as EnvironmentId,
  } as unknown as EnvironmentThreadShell;
}

const projectTitles = new Map([["primary:project-1", "houston"]]);
const noProviders = new Map<ProviderInstanceId, string>([
  ["claude" as ProviderInstanceId, "claude"],
]);
const nothingDelegated = new Set<string>();

describe("tray payload", () => {
  it("names the connection from the environments' phases", () => {
    expect(trayConnection(["connected", "connecting"])).toBe("ready");
    expect(trayConnection(["connecting"])).toBe("connecting");
    expect(trayConnection(["error", "connecting"])).toBe("failed");
    expect(trayConnection([])).toBe("reconnecting");
  });

  it("maps thread attention to the tray's needs-input state and keeps the project name", () => {
    const payload = buildTrayPayload(
      [
        thread({
          id: "t1",
          environmentId: "primary",
          hasPendingApprovals: true,
        }),
        thread({
          id: "t2",
          environmentId: "primary",
          runtime: { status: "running" },
        }),
      ],
      ["connected"],
      projectTitles,
      noProviders,
      nothingDelegated,
    );

    expect(payload.connection).toBe("ready");
    expect(payload.sessions).toEqual([
      {
        id: "primary:t1",
        agent: "claude",
        title: "Refactor auth",
        status: "needsInput",
        needsInput: true,
        workspace: "houston",
      },
      {
        id: "primary:t2",
        agent: "claude",
        title: "Refactor auth",
        status: "running",
        needsInput: false,
        workspace: "houston",
      },
    ]);
  });

  it("drops archived, deleted and subagent threads", () => {
    const payload = buildTrayPayload(
      [
        thread({ id: "archived", environmentId: "primary", archivedAt: "2026-01-01T00:00:00Z" }),
        thread({ id: "deleted", environmentId: "primary", deletedAt: "2026-01-01T00:00:00Z" }),
        thread({
          id: "child",
          environmentId: "primary",
          lineage: { relationshipToParent: "subagent", sideChat: false },
        }),
        thread({ id: "shown", environmentId: "primary" }),
      ],
      ["connected"],
      projectTitles,
      noProviders,
      nothingDelegated,
    );

    expect(payload.sessions.map((session) => session.id)).toEqual([
      trayThreadKey("primary" as EnvironmentId, "shown" as ThreadId),
    ]);
  });

  it("falls back to Houston when the workspace is not known yet", () => {
    const payload = buildTrayPayload(
      [thread({ id: "t1", environmentId: "other" })],
      ["connected"],
      projectTitles,
      new Map(),
      nothingDelegated,
    );
    expect(payload.sessions[0]?.workspace).toBe("Houston");
    expect(payload.sessions[0]?.agent).toBe("claude");
  });
});
