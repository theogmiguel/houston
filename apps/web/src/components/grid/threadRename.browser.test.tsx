import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";
import { EMPTY_THREAD_TITLE_MESSAGE, ThreadTitleInput } from "./threadTitleInput";

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

function thread(): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Greeting",
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
  } as unknown as EnvironmentThreadShell;
}

describe("ThreadTitleInput", () => {
  it("selects the whole title when it takes focus", async () => {
    await using screen = await render(
      <ThreadTitleInput title="Greeting" onCommit={() => {}} onCancel={() => {}} />,
      { router: false },
    );
    const input = screen.getByRole("textbox").element() as HTMLInputElement;
    await expect.poll(() => [input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  });

  it("commits the trimmed title once on Enter and cancels on Escape", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    await using screen = await render(
      <ThreadTitleInput title="Greeting" onCommit={onCommit} onCancel={onCancel} />,
      { router: false },
    );
    await userEvent.fill(screen.getByRole("textbox").element(), "  Hello  ");
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Hello");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels on Escape without committing", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    await using screen = await render(
      <ThreadTitleInput title="Greeting" onCommit={onCommit} onCancel={onCancel} />,
      { router: false },
    );
    await userEvent.fill(screen.getByRole("textbox").element(), "Changed");
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("refuses an empty title with a message and keeps editing, then clears the message on typing", async () => {
    const onCommit = vi.fn();
    await using screen = await render(
      <ThreadTitleInput title="Greeting" onCommit={onCommit} onCancel={() => {}} />,
      { router: false },
    );
    const input = screen.getByRole("textbox");
    await userEvent.fill(input.element(), "   ");
    await userEvent.keyboard("{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent(EMPTY_THREAD_TITLE_MESSAGE);
    expect(input.element().getAttribute("aria-invalid")).toBe("true");
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.type(input.element(), "x");
    expect(screen.container.querySelector("[role='alert']")).toBeNull();
  });

  it("reverts an empty title when focus leaves instead of saving it", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    await using screen = await render(
      <ThreadTitleInput title="Greeting" onCommit={onCommit} onCancel={onCancel} />,
      { router: false },
    );
    await userEvent.fill(screen.getByRole("textbox").element(), "");
    (screen.getByRole("textbox").element() as HTMLInputElement).blur();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores Enter and Escape while an input method is composing", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    await using screen = await render(
      <ThreadTitleInput title="Greeting" onCommit={onCommit} onCancel={onCancel} />,
      { router: false },
    );
    const input = screen.getByRole("textbox").element();
    for (const key of ["Enter", "Escape"]) {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true }),
      );
    }
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("ThreadCard rename", () => {
  it("starts renaming on a double-click of the title without opening the thread twice", async () => {
    const onOpen = vi.fn();
    const onRename = vi.fn();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <ThreadCard
          gridId={null}
          thread={thread()}
          query=""
          providerEntries={new Map()}
          nowIso="2026-01-01T00:00:00.000Z"
          focused={false}
          selected={false}
          dragging={false}
          workspaceTitle="Houston"
          onOpen={onOpen}
          onSelect={() => {}}
          onClose={() => {}}
          onHold={() => {}}
          onPickHoldTime={async () => null}
          onRename={onRename}
          onSetAutoClose={() => {}}
          onDropOnThread={() => {}}
        />
      </TooltipProvider>,
    );
    await userEvent.dblClick(screen.container.querySelector("[data-card-open]") as HTMLElement);

    const input = screen.getByRole("textbox");
    await expect.element(input).toHaveFocus();
    expect(onOpen).toHaveBeenCalledTimes(1);

    await userEvent.fill(input.element(), "Renamed");
    await userEvent.keyboard("{Enter}");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Renamed");
  });
});
