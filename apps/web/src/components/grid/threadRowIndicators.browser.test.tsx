import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";
import { ThreadJumpHintContext } from "./threadJumpHints";

const fixture = vi.hoisted(() => ({
  terminalIds: [] as string[],
  totals: null as { insertions: number; deletions: number } | null,
  primary: "env-1" as string | null,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => fixture.primary) as never,
  useEnvironmentMachines: (() => new Map([["env-2", "server"]])) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProject: (() => ({ workspaceRoot: "/repo" })) as never,
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: fixture.totals === null ? null : { refName: "main", workingTree: fixture.totals },
  })) as never,
}));
vi.mock(import("../../state/vcs"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => ({})) as never },
  };
});
vi.mock(import("../../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useThreadRunningTerminalIds: (() => fixture.terminalIds) as never,
}));
function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Indicator thread",
    branch: "feature/x",
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
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    tags: [],
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function card(
  value: EnvironmentThreadShell,
  props: { onOpen?: () => void; focused?: boolean; selected?: boolean; timeLabel?: string } = {},
) {
  return (
    <TooltipProvider delay={0}>
      <ThreadCard
        gridId="grid-a"
        thread={value}
        query=""
        providerEntries={new Map()}
        nowIso="2026-01-01T00:00:00.000Z"
        focused={props.focused ?? false}
        selected={props.selected ?? false}
        dragging={false}
        workspaceTitle="Houston"
        timeLabel={props.timeLabel ?? null}
        onOpen={props.onOpen ?? (() => {})}
        onSelect={() => {}}
        onClose={() => {}}
        onHold={() => {}}
        onPickHoldTime={async () => null}
        onRename={() => {}}
        onSetAutoClose={() => {}}
        onDropOnThread={() => {}}
      />
    </TooltipProvider>
  );
}

const draftRef = scopeThreadRef("env-1" as never, "thread-a" as never);

function reset() {
  useComposerDraftStore.getState().clearComposerContent(draftRef);
  fixture.terminalIds = [];
  fixture.totals = null;
  fixture.primary = "env-1";
}

describe("thread row indicators", () => {
  it("shows no indicator for a quiet local thread", async () => {
    reset();
    await using screen = await render(card(thread()));
    expect(screen.container.querySelector("[data-thread-diff], [data-thread-draft]")).toBeNull();
    expect(screen.getByRole("img", { name: "Local checkout" }).element()).toBeVisible();
  });

  it("shows the worktree mark instead of the local mark for a worktree thread", async () => {
    reset();
    await using screen = await render(card(thread({ worktreePath: "/worktrees/feature-x" })));
    expect(screen.container.querySelector("[data-thread-worktree]")).not.toBeNull();
    expect(screen.container.querySelector("[aria-label='Local checkout']")).toBeNull();
  });

  it("opens the thread from the running-terminal icon", async () => {
    reset();
    fixture.terminalIds = ["term-1"];
    const onOpen = vi.fn();
    await using screen = await render(card(thread(), { onOpen }));
    await userEvent.click(
      screen.getByRole("button", { name: "1 terminal process running. Open terminal" }).element(),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows the unsent draft pen and discards the draft from it", async () => {
    reset();
    useComposerDraftStore.getState().setPrompt(draftRef, "half-written");
    // Other test files share this store, so check this thread's draft rather than an empty store.
    const draftKey = composerTargetKey(draftRef);
    expect(useComposerDraftStore.getState().draftsByThreadKey[draftKey]).toBeDefined();
    await using screen = await render(card(thread()));
    await userEvent.click(
      screen.getByRole("button", { name: "Discard draft in Indicator thread" }).element(),
    );
    await expect.poll(() => screen.container.querySelector("[data-thread-draft]")).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadKey[draftKey]).toBeUndefined();
  });

  it("hides the draft pen on the thread that is open", async () => {
    reset();
    useComposerDraftStore.getState().setPrompt(draftRef, "half-written");
    await using screen = await render(card(thread(), { focused: true }));
    expect(screen.container.querySelector("[data-thread-draft]")).toBeNull();
  });

  it("shows the uncommitted line totals", async () => {
    reset();
    fixture.totals = { insertions: 12, deletions: 3 };
    await using screen = await render(card(thread()));
    const stats = screen.getByRole("img", { name: "Uncommitted changes +12 −3" }).element();
    expect(stats.textContent).toBe("+12 −3");
  });

  it("mutes the line totals at rest and colours them on hover, focus and for the open or selected row", async () => {
    reset();
    fixture.totals = { insertions: 12, deletions: 3 };
    const colors = (container: HTMLElement) => {
      const [added, removed] = [
        ...container.querySelectorAll("[aria-label^='Uncommitted'] > span"),
      ];
      const probe = (name: string) => {
        const el = document.createElement("span");
        el.className = name;
        container.append(el);
        const color = getComputedStyle(el).color;
        el.remove();
        return color;
      };
      return {
        added: getComputedStyle(added!).color,
        removed: getComputedStyle(removed!).color,
        meta: getComputedStyle(container.querySelector("[data-thread-meta]")!).color,
        addition: probe("text-diff-addition-foreground"),
        deletion: probe("text-diff-deletion-foreground"),
      };
    };

    await using rest = await render(card(thread()));
    const resting = colors(rest.container);
    expect(resting.added).toBe(resting.meta);
    expect(resting.removed).toBe(resting.meta);
    expect(resting.addition).not.toBe(resting.meta);

    await userEvent.hover(rest.getByRole("img", { name: "Uncommitted changes +12 −3" }).element());
    await expect.poll(() => colors(rest.container).added).toBe(resting.addition);
    expect(colors(rest.container).removed).toBe(resting.deletion);

    await using selected = await render(card(thread(), { selected: true }));
    const selectedColors = colors(selected.container);
    expect(selectedColors.added).toBe(selectedColors.addition);
    expect(selectedColors.removed).toBe(selectedColors.deletion);

    await using open = await render(card(thread(), { focused: true }));
    const openColors = colors(open.container);
    expect(openColors.added).toBe(openColors.addition);
    expect(openColors.removed).toBe(openColors.deletion);
  });

  it("shows no totals for a clean checkout", async () => {
    reset();
    fixture.totals = { insertions: 0, deletions: 0 };
    await using screen = await render(card(thread()));
    expect(screen.container.textContent).not.toContain("+0");
  });

  it("marks a thread in another environment with its machine", async () => {
    reset();
    await using screen = await render(card(thread({ environmentId: "env-2" as never })));
    expect(screen.container.querySelector("[data-thread-remote]")).not.toBeNull();
  });

  it("dims the title and marks the row busy while its title regenerates", async () => {
    reset();
    await using screen = await render(
      card(thread({ titleRegeneration: { requestId: "r", startedAt: "2026-01-01T00:00:00Z" } })),
    );
    const row = screen.container.querySelector("[data-thread-key]");
    expect(row?.getAttribute("aria-busy")).toBe("true");
    expect(
      Number(getComputedStyle(screen.getByText("Indicator thread").element()).opacity),
    ).toBeLessThan(1);
  });

  it("leaves the row idle when no title is regenerating", async () => {
    reset();
    await using screen = await render(card(thread()));
    expect(screen.container.querySelector("[data-thread-key]")?.hasAttribute("aria-busy")).toBe(
      false,
    );
  });

  it("shows the jump shortcut in place of the age while the hints are up", async () => {
    reset();
    const key = scopedThreadKey(draftRef);
    await using screen = await render(
      <ThreadJumpHintContext.Provider value={new Map([[key, "Ctrl+2"]])}>
        {card(thread(), { timeLabel: "5m" })}
      </ThreadJumpHintContext.Provider>,
    );
    expect(screen.container.querySelector("[data-thread-jump-hint]")?.textContent).toBe("Ctrl+2");
    expect(screen.container.textContent).not.toContain("5m");
  });

  it("shows the age and no badge when the hints are down", async () => {
    reset();
    await using screen = await render(card(thread(), { timeLabel: "5m" }));
    expect(screen.container.querySelector("[data-thread-jump-hint]")).toBeNull();
    expect(screen.container.textContent).toContain("5m");
  });
});
