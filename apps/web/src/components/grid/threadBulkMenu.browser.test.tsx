import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";
import { ThreadBulkMenuContext, useBulkThreadMenu } from "./useBulkThreadMenu";

const fixture = vi.hoisted(() => ({
  chosen: null as string | null,
  shown: [] as Array<{ items: Array<{ id: string; label: string }>; position: unknown }>,
  confirm: true as boolean | undefined,
  custom: null as { snoozedUntil: string } | null,
  markUnread: [] as unknown[],
  deleted: [] as unknown[],
  regenerated: [] as unknown[],
}));

vi.mock(import("../../localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    readLocalApi: (() => ({
      ...actual.readLocalApi(),
      contextMenu: {
        show: async (items: Array<{ id: string; label: string }>, position: unknown) => {
          fixture.shown.push({ items, position });
          return fixture.chosen;
        },
        close: () => {},
      },
    })) as never,
  };
});
vi.mock(import("../../confirmDialog"), async (original) => ({
  ...(await original()),
  requestConfirmDialog: (() => Promise.resolve(fixture.confirm)) as never,
}));
vi.mock(import("../CustomSnoozeDialog"), async (original) => ({
  ...(await original()),
  requestCustomSnooze: (async () => fixture.custom) as never,
}));
vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useAcknowledgeThreadWoke: (() => () => {}) as never,
  useThreadActions: (() => ({
    markThreadUnread: (ref: unknown) => fixture.markUnread.push(ref),
    deleteThread: async (ref: unknown) => {
      fixture.deleted.push(ref);
      return { _tag: "Success" };
    },
    regenerateThreadTitle: async (ref: unknown) => {
      fixture.regenerated.push(ref);
      return { _tag: "Success" };
    },
  })) as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
  useEnvironmentMachines: (() => new Map()) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
}));

const NOW = "2026-01-01T12:00:00.000Z";

function thread(id: string, overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId: "project-1",
    title: id,
    branch: "main",
    worktreePath: null,
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    tags: [],
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function reset() {
  fixture.chosen = null;
  fixture.shown = [];
  fixture.confirm = true;
  fixture.custom = null;
  fixture.markUnread = [];
  fixture.deleted = [];
  fixture.regenerated = [];
}

function rightClick(container: HTMLElement) {
  container
    .querySelector<HTMLElement>("[data-thread-key]")!
    .dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }),
    );
}

function card(selected: boolean, bulk: ((position: { x: number; y: number }) => void) | null) {
  return (
    <ThreadBulkMenuContext.Provider value={bulk}>
      <TooltipProvider delay={0}>
        <ThreadCard
          gridId="grid-a"
          thread={thread("a")}
          query=""
          providerEntries={new Map()}
          nowIso={NOW}
          focused={false}
          selected={selected}
          dragging={false}
          workspaceTitle="Houston"
          onOpen={() => {}}
          onSelect={() => {}}
          onClose={() => {}}
          onHold={() => {}}
          onPickHoldTime={async () => null}
          onRename={() => {}}
          onSetAutoClose={() => {}}
          onDropOnThread={() => {}}
        />
      </TooltipProvider>
    </ThreadBulkMenuContext.Provider>
  );
}

describe("right-click on a selected row", () => {
  it("opens the bulk menu at the pointer instead of the single-thread menu", async () => {
    reset();
    const bulk = vi.fn();
    await using screen = await render(card(true, bulk));
    rightClick(screen.container);
    expect(bulk).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 40 });
    expect(fixture.shown).toEqual([]);
  });

  it("opens the single-thread menu on an unselected row or when there is no multi-selection", async () => {
    reset();
    const bulk = vi.fn();
    await using unselected = await render(card(false, bulk));
    rightClick(unselected.container);
    await vi.waitFor(() => expect(fixture.shown).toHaveLength(1));
    expect(bulk).not.toHaveBeenCalled();
    await unselected[Symbol.asyncDispose]();

    reset();
    await using single = await render(card(true, null));
    rightClick(single.container);
    await vi.waitFor(() => expect(fixture.shown).toHaveLength(1));
  });
});

function Harness(props: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  onClose: (threads: ReadonlyArray<EnvironmentThreadShell>) => void;
  onHold: (threads: ReadonlyArray<EnvironmentThreadShell>, until: string) => void;
  onDone: () => void;
}) {
  const open = useBulkThreadMenu({ selectedThreads: props.threads, nowIso: NOW, ...props });
  return (
    <button type="button" onClick={() => void open({ x: 1, y: 2 })}>
      menu
    </button>
  );
}

async function run(
  chosen: string | null,
  threads: EnvironmentThreadShell[],
  handlers = { onClose: vi.fn(), onHold: vi.fn(), onDone: vi.fn() },
) {
  fixture.chosen = chosen;
  const screen = await render(<Harness threads={threads} {...handlers} />, { router: false });
  await userEvent.click(screen.getByRole("button", { name: "menu" }).element());
  await vi.waitFor(() => expect(fixture.shown).toHaveLength(1));
  return { screen, handlers };
}

describe("bulk thread menu", () => {
  it("lists the actions with the selection count", async () => {
    reset();
    const { screen } = await run(null, [thread("a"), thread("b")]);
    expect(fixture.shown[0]?.items.map((item) => item.label)).toEqual([
      "Close (2)",
      "Hold (2)",
      "Regenerate titles (2)",
      "Mark unread (2)",
      "Delete (2)",
    ]);
    expect(fixture.shown[0]?.position).toEqual({ x: 1, y: 2 });
    await screen[Symbol.asyncDispose]();
  });

  it("closes only the threads that are still open", async () => {
    reset();
    const open = thread("a");
    const { screen, handlers } = await run("close", [
      open,
      thread("b", { settledOverride: "settled" }),
    ]);
    await vi.waitFor(() => expect(handlers.onDone).toHaveBeenCalledOnce());
    expect(handlers.onClose).toHaveBeenCalledExactlyOnceWith([open]);
    await screen[Symbol.asyncDispose]();
  });

  it("holds the whole selection until the picked custom time", async () => {
    reset();
    fixture.custom = { snoozedUntil: "2026-01-02T09:00:00.000Z" };
    const threads = [thread("a"), thread("b")];
    const { screen, handlers } = await run("hold:custom", threads);
    await vi.waitFor(() => expect(handlers.onHold).toHaveBeenCalledOnce());
    expect(handlers.onHold).toHaveBeenCalledWith(threads, "2026-01-02T09:00:00.000Z");
    await screen[Symbol.asyncDispose]();
  });

  it("holds nothing when the custom time dialog is dismissed", async () => {
    reset();
    const { screen, handlers } = await run("hold:custom", [thread("a"), thread("b")]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handlers.onHold).not.toHaveBeenCalled();
    expect(handlers.onDone).not.toHaveBeenCalled();
    await screen[Symbol.asyncDispose]();
  });

  it("marks every selected thread unread", async () => {
    reset();
    const { screen, handlers } = await run("mark-unread", [thread("a"), thread("b")]);
    await vi.waitFor(() => expect(handlers.onDone).toHaveBeenCalledOnce());
    expect(fixture.markUnread).toHaveLength(2);
    await screen[Symbol.asyncDispose]();
  });

  it("regenerates titles only for threads not already regenerating", async () => {
    reset();
    const busy = thread("b", { titleRegeneration: { requestId: "r", startedAt: NOW } });
    const { screen, handlers } = await run("regenerate-title", [thread("a"), busy]);
    await vi.waitFor(() => expect(handlers.onDone).toHaveBeenCalledOnce());
    expect(fixture.regenerated).toHaveLength(1);
    await screen[Symbol.asyncDispose]();
  });

  it("deletes the selection after confirmation", async () => {
    reset();
    const { screen, handlers } = await run("delete", [thread("a"), thread("b")]);
    await vi.waitFor(() => expect(handlers.onDone).toHaveBeenCalledOnce());
    expect(fixture.deleted).toHaveLength(2);
    await screen[Symbol.asyncDispose]();
  });

  it("deletes nothing when the confirmation is declined", async () => {
    reset();
    fixture.confirm = false;
    const { screen, handlers } = await run("delete", [thread("a"), thread("b")]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.deleted).toEqual([]);
    expect(handlers.onDone).not.toHaveBeenCalled();
    await screen[Symbol.asyncDispose]();
  });
});
