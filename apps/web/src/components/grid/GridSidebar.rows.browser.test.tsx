import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { beginThreadDragAt, endThreadDrag, useThreadDropTarget } from "../../grid/threadDrag";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { act, render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
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

const LONG_TITLE = "App de desenvolvimento para testes com um nome bem comprido";

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Split drawer state from the thread store",
    branch: "houston/split-drawer-state",
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
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

interface CardOverrides {
  shelf?: "snoozed" | "settled" | null;
  gridId?: string | null;
  notInGrid?: boolean;
  timeLabel?: string | null;
  runningSubagents?: number;
  onOpen?: () => void;
  onSelect?: (input: { shiftKey: boolean; toggleKey: boolean }) => void;
  onWake?: () => void;
  onReopen?: () => void;
  onDropOnThread?: (source: unknown) => void;
}

function card(value: EnvironmentThreadShell, overrides: CardOverrides = {}) {
  return (
    <TooltipProvider delay={0}>
      <ThreadCard
        gridId={overrides.gridId === undefined ? "grid-a" : overrides.gridId}
        thread={value}
        query=""
        providerEntries={new Map()}
        nowIso="2026-01-01T00:00:00.000Z"
        focused={false}
        selected={false}
        dragging={false}
        workspaceTitle="Houston"
        timeLabel={overrides.timeLabel === undefined ? "9:00" : overrides.timeLabel}
        shelf={overrides.shelf ?? null}
        notInGrid={overrides.notInGrid ?? false}
        runningSubagents={overrides.runningSubagents ?? 0}
        onOpen={overrides.onOpen ?? (() => {})}
        onSelect={overrides.onSelect ?? (() => {})}
        onClose={() => {}}
        onHold={() => {}}
        onPickHoldTime={async () => null}
        onRename={() => {}}
        onSetAutoClose={() => {}}
        onDropOnThread={overrides.onDropOnThread ?? (() => {})}
        {...(overrides.onWake === undefined ? {} : { onWake: overrides.onWake })}
        {...(overrides.onReopen === undefined ? {} : { onReopen: overrides.onReopen })}
      />
    </TooltipProvider>
  );
}

function DropTargetProbe() {
  const target = useThreadDropTarget();
  return <output data-testid="drop-target">{target === null ? "none" : target.kind}</output>;
}

function rowOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-thread-key]")!;
}

function titleOf(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>("[data-card-open] > span")!;
}

describe("ThreadCard for a thread no grid shows", () => {
  it("does not register a drop target", async () => {
    using _drag = { [Symbol.dispose]: () => endThreadDrag() };
    const onDropOnThread = vi.fn();
    await using screen = await render(
      <>
        {card(thread(), { gridId: null, notInGrid: true, onDropOnThread })}
        <DropTargetProbe />
      </>,
    );
    const rect = rowOf(screen.container).getBoundingClientRect();

    await act(() =>
      beginThreadDragAt(
        { gridId: "grid-a", threadId: "thread-b", environmentId: "env-1", projectId: "project-1" },
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        1,
      ),
    );

    expect(screen.getByTestId("drop-target").element().textContent).toBe("none");
  });
});
