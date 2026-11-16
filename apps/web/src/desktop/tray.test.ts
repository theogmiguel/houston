import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { environmentThreadShells } from "../state/threads";
import { buildTrayPayload, startTraySync, trayConnection, trayThreadKey } from "./tray";

vi.mock("../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      threadShellsAtom: Atom.make<ReadonlyArray<unknown>>([]),
      quietThreadShellsAtom: Atom.make<ReadonlyArray<unknown>>([]),
      delegatedUnderParentAtom: Atom.make<ReadonlySet<string>>(new Set<string>()),
    },
  };
});
vi.mock("../state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentProjects: { projectsAtom: Atom.make<ReadonlyArray<unknown>>([]) } };
});
vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(new Map([["primary", { connection: { phase: "connected" } }]])),
      providersByEnvironmentAtom: Atom.make(new Map()),
    },
  };
});

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

describe("startTraySync", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup(initial: ReadonlyArray<EnvironmentThreadShell>) {
    vi.useFakeTimers();
    const traySync = vi.fn(async (_payload: unknown) => {});
    vi.stubGlobal("window", {
      hostBridge: { traySync },
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    const live = environmentThreadShells.threadShellsAtom;
    const quiet = environmentThreadShells.quietThreadShellsAtom;
    if (!Atom.isWritable(live) || !Atom.isWritable(quiet)) {
      throw new Error("Expected writable test shell state");
    }
    registry.set(live, initial);
    registry.set(quiet, initial);
    const stop = startTraySync(registry, {} as AnyRouter);
    const flush = () => {
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
    };
    return {
      traySync,
      setLive(next: ReadonlyArray<EnvironmentThreadShell>) {
        registry.set(live, next);
        flush();
      },
      setShells(next: ReadonlyArray<EnvironmentThreadShell>) {
        registry.set(live, next);
        registry.set(quiet, next);
        flush();
      },
      [Symbol.dispose]() {
        stop();
        registry.dispose();
      },
    };
  }

  const running = (overrides: Record<string, unknown> = {}) =>
    thread({ id: "t1", environmentId: "primary", runtime: { status: "running" }, ...overrides });

  it("sends nothing on streaming ticks that leave the tray unchanged", () => {
    using tray = setup([running()]);
    expect(tray.traySync).toHaveBeenCalledTimes(1);

    for (let tick = 0; tick < 8; tick += 1) {
      tray.setLive([running({ updatedAt: `2026-01-01T00:00:0${tick}Z`, itemCount: tick })]);
      vi.advanceTimersByTime(300);
    }

    expect(tray.traySync).toHaveBeenCalledTimes(1);
  });

  it("skips a payload equal to the last one sent and still sends a status change", () => {
    using tray = setup([running()]);
    tray.setShells([running({ updatedAt: "2026-01-01T00:00:05Z" })]);
    vi.advanceTimersByTime(300);
    expect(tray.traySync).toHaveBeenCalledTimes(1);

    tray.setShells([running({ hasPendingApprovals: true })]);
    vi.advanceTimersByTime(300);
    expect(tray.traySync).toHaveBeenCalledTimes(2);
    expect(tray.traySync.mock.calls[1]?.[0]).toMatchObject({
      sessions: [{ id: "primary:t1", status: "needsInput", needsInput: true }],
    });
  });

  it("drops a pending payload when the tray returns to what it last sent", () => {
    using tray = setup([running()]);
    tray.setShells([running({ title: "Renamed" })]);
    tray.setShells([running()]);
    vi.advanceTimersByTime(300);
    expect(tray.traySync).toHaveBeenCalledTimes(1);
  });
});
