import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ projection: null as unknown, commandSucceeds: false }));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => false) as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShell: (() => null) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: state.projection }) as never,
  useThreadRelationshipShells: (() =>
    state.projection === null ? [] : [(state.projection as { thread: unknown }).thread]) as never,
  useProjects: (() => []) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: (() => null) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: (() => ({ snapshots: [] })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async () =>
    state.commandSucceeds
      ? AsyncResult.success(undefined)
      : AsyncResult.failure(Cause.fail(new Error("Connection lost")))) as never,
}));

import { render } from "../../../test/render";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("fork");

function setup() {
  state.commandSucceeds = false;
  state.projection = {
    thread: {
      id: threadId,
      title: "Fork",
      activeProviderThreadId: null,
      lineage: { parentThreadId: ThreadId.make("source"), relationshipToParent: "fork" },
      forkedFrom: null,
    },
    runs: [{ id: "run", ordinal: 1, status: "completed" }],
    subagents: [],
    contextTransfers: [],
    providerThreads: [],
    providerSessions: [{ id: "session", status: "ready" }],
  };
}


async function runAction(
  screen: Awaited<ReturnType<typeof render>>,
  action: "merge" | "disconnect",
) {
  if (action === "merge") {
    await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
  } else {
    await screen.getByRole("button", { name: "More thread actions" }).click();
    await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
  }
}

it.each(["merge", "disconnect"] as const)(
  "a rejected %s command stays on the fork and clears the busy state",
  async (action) => {
    setup();
    await using screen = await render(
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />,
      { router: "/environment/fork" },
    );

    await runAction(screen, action);

    expect(screen.router?.state.location.pathname).toBe("/environment/fork");
    await expect
      .element(
        screen.getByRole("button", {
          name: action === "merge" ? "Merge back to source conversation" : "More thread actions",
        }),
      )
      .toBeEnabled();
  },
);

it.each(["merge", "disconnect"] as const)(
  "a successful %s retry after a rejection finishes the action",
  async (action) => {
    setup();
    await using screen = await render(
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />,
      { router: "/environment/fork" },
    );

    await runAction(screen, action);
    expect(screen.router?.state.location.pathname).toBe("/environment/fork");

    state.commandSucceeds = true;
    await runAction(screen, action);

    const expectedPath = action === "merge" ? "/environment/source" : "/environment/fork";
    await vi.waitFor(() => {
      expect(screen.router?.state.location.pathname).toBe(expectedPath);
    });
    if (action === "disconnect") {
      await expect
        .element(screen.getByRole("button", { name: "More thread actions" }))
        .toBeEnabled();
    }
  },
);
