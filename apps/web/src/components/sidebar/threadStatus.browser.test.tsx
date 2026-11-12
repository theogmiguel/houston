import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./ThreadCard";
import { PaneThreadStatusMark } from "./threadStatusMark";

const acknowledged = vi.hoisted(() => [] as Array<{ target: unknown; wokeAt: string }>);

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
vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useAcknowledgeThreadWoke: (() => (target: unknown, wokeAt: string) => {
    acknowledged.push({ target, wokeAt });
  }) as never,
}));

const NOW = "2026-01-01T12:00:00.000Z";

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Status thread",
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
    pendingSubagentRequest: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    tags: [],
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function card(
  value: EnvironmentThreadShell,
  shelf: "settled" | "snoozed" | null = null,
  timeLabel: string | null = null,
) {
  return (
    <TooltipProvider delay={0}>
      <ThreadCard
        workspaceId={null}
        thread={value}
        query=""
        providerEntries={new Map()}
        nowIso={NOW}
        focused={false}
        selected={false}
        dragging={false}
        projectTitle="Houston"
        shelf={shelf}
        timeLabel={timeLabel}
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
  );
}

function statusLine(container: HTMLElement): string {
  return container.querySelector("[data-thread-status]")?.textContent ?? "";
}

function failedThread(): EnvironmentThreadShell {
  return thread({
    latestRun: {
      id: "run-failed",
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
    },
    runtime: { status: "failed", lastErrorClass: "provider" },
  });
}

describe("thread status glyphs", () => {
  it("draws the same kind on the rail row and the grid pane label", async () => {
    const failed = failedThread();
    await using row = await render(card(failed));
    await using pane = await render(
      <PaneThreadStatusMark thread={failed} status={{ state: "failed", label: "Failed" }} />,
    );

    const rowGlyph = row.container.querySelector<SVGElement>(
      "[data-thread-status-glyph] [data-status-kind]",
    )!;
    const paneGlyph = pane.container.querySelector<SVGElement>("[data-status-kind]")!;
    expect(rowGlyph.getAttribute("data-status-kind")).toBe("failed");
    expect(paneGlyph.getAttribute("data-status-kind")).toBe("failed");
    expect(paneGlyph.innerHTML).toBe(rowGlyph.innerHTML);
  });
});

describe("thread status words", () => {
  it("says Approval, Input and Request instead of Needs you", async () => {
    await using approval = await render(card(thread({ hasPendingApprovals: true })));
    expect(statusLine(approval.container)).toBe("Approval");
    await using input = await render(card(thread({ hasPendingUserInput: true })));
    expect(statusLine(input.container)).toBe("Input");
    await using request = await render(card(thread({ pendingSubagentRequest: "user_input" })));
    expect(statusLine(request.container)).toBe("Request");
  });

  it("says how long a thread has been Waiting", async () => {
    await using screen = await render(
      card(
        thread({
          blockedOnThreadWait: true,
          runtime: {
            status: "running",
            activeRunId: "run-1",
            activityStartedAt: "2025-12-31T11:00:00.000Z",
          },
        }),
      ),
    );
    await expect.poll(() => statusLine(screen.container)).toMatch(/^Waiting \d+h \d+m$/);
  });

  it("shows Goal for a running thread pursuing a goal", async () => {
    await using screen = await render(
      card(
        thread({
          goal: { status: "active" },
          runtime: { status: "running", activeRunId: "r", activityStartedAt: NOW },
        }),
      ),
    );
    expect(statusLine(screen.container)).toMatch(/^Goal/);
  });

  it("shows when a Closed row was closed", async () => {
    await using screen = await render(
      card(thread({ settledOverride: "settled" }), "settled", "Closed 2h"),
    );
    expect(screen.getByText("Closed 2h").element()).toBeVisible();
  });

  it("dismisses the Back mark from its word", async () => {
    await using screen = await render(card(thread({ unsettledAt: "2026-01-01T11:00:00.000Z" })));
    expect(screen.container.querySelector("[data-thread-back-dismiss]")?.textContent).toBe("Back");
    expect(screen.getByRole("img", { name: "Back" }).element()).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss back notification" }).element(),
    );
    expect(acknowledged).toHaveLength(1);
    expect(acknowledged[0]?.wokeAt).toBe("2026-01-01T11:00:00.000Z");
  });

  it("offers Hold on a thread that can be held and hides it while a request is pending", async () => {
    await using plain = await render(card(thread()));
    expect(plain.getByRole("button", { name: "Hold" }).element()).toBeInTheDocument();
    await using asking = await render(card(thread({ hasPendingUserInput: true })));
    expect(asking.container.querySelector("[aria-label='Hold']")).toBeNull();
    expect(asking.getByRole("button", { name: "Close thread" }).element()).toBeInTheDocument();
  });
});
