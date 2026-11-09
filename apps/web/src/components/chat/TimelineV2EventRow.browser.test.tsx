import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

vi.mock("../../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/threads")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentThreadDetails: {
      ...actual.environmentThreadDetails,
      threadAtom: () => Atom.make(null),
    },
  };
});

vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: () => Atom.make([]),
    },
  };
});

import { V2EventTimelineRow } from "./TimelineV2EventRow";
import { TimelineRowCtx } from "./timelineRowContext";

const capturesEnabled = import.meta.env.VITE_HOUSTON_CAPTURES === "1";
const ENVIRONMENT = EnvironmentId.make("environment");
const PARENT = ThreadId.make("parent");
const RENDERER = ThreadId.make("renderer");
const CONTRACTS = ThreadId.make("contracts");

function subagentItem(
  id: string,
  title: string,
  status: "completed" | "running",
  childThreadId: ThreadId,
  result: string | null = null,
) {
  return {
    id: NodeId.make(id),
    type: "subagent" as const,
    threadId: PARENT,
    subagentId: NodeId.make(id),
    parentNodeId: NodeId.make("parent-node"),
    origin: "app_owned" as const,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId,
    nativeTaskRef: null,
    prompt: "Review the codebase",
    title,
    model: null,
    status,
    progress: undefined,
    result,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
  };
}

function row() {
  const renderer = subagentItem("subagent-renderer", "Review: web renderer", "running", RENDERER);
  const contracts = subagentItem(
    "subagent-contracts",
    "Review: server and contracts",
    "completed",
    CONTRACTS,
    "Found two stale contract exports and removed them.",
  );
  return {
    id: "subagent-group-row",
    kind: "event" as const,
    continuesWorkLog: false,
    projectedItem: { item: renderer },
    subagents: [{ item: renderer }, { item: contracts }],
  };
}

describe("subagent group", () => {
  it("summarises the group as a card, expands to two-line rows and opens a subagent", async () => {
    const onOpenThread = vi.fn();
    const onToggleWorkEntry = vi.fn();
    await using screen = await render(
      <TimelineRowCtx
        value={
          {
            activeThreadEnvironmentId: ENVIRONMENT,
            workGroupViewState: { scrollPositions: new Map(), expandedEntries: new Set() },
            runs: [],
            onOpenThread,
            onToggleWorkEntry,
          } as never
        }
      >
        <V2EventTimelineRow row={row() as never} />
      </TimelineRowCtx>,
    );

    const summary = screen.getByRole("button", { name: "2 subagents, 1 working, 1 done" });
    await expect.element(summary).toBeVisible();
    await expect.element(screen.getByText("1 working, 1 done")).toBeVisible();
    await expect.element(screen.getByText("Review: web renderer")).not.toBeInTheDocument();

    await userEvent.click(summary);
    await expect.element(screen.getByText("Review: web renderer")).toBeVisible();
    await expect.element(screen.getByText("Review: server and contracts")).toBeVisible();
    await expect.element(screen.getByText("Running")).toBeVisible();
    await expect
      .element(screen.getByText("Found two stale contract exports and removed them."))
      .toBeVisible();
    expect(onToggleWorkEntry).toHaveBeenCalledWith("subagent-group-row", false);

    await userEvent.click(screen.getByRole("button", { name: "Open Review: web renderer" }));
    expect(onOpenThread).toHaveBeenCalledWith(RENDERER);

    await userEvent.click(summary);
    await expect.element(screen.getByText("Review: web renderer")).not.toBeInTheDocument();
  });
});

/** Captures read a fixed clock so their elapsed times are the same on every run. */
const CAPTURE_NOW = Date.parse("2026-11-09T12:00:00.000Z");

type CaptureStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled";

function captureAgent(
  id: string,
  title: string,
  status: CaptureStatus,
  options: {
    readonly result?: string;
    readonly startedMinutesAgo?: number;
    readonly ranMinutes?: number;
  } = {},
) {
  const now = CAPTURE_NOW;
  const startedAt =
    options.startedMinutesAgo === undefined
      ? null
      : DateTime.makeUnsafe(now - options.startedMinutesAgo * 60_000);
  const completedAt =
    startedAt === null || options.ranMinutes === undefined
      ? null
      : DateTime.makeUnsafe(DateTime.toEpochMillis(startedAt) + options.ranMinutes * 60_000);
  return {
    ...subagentItem(id, title, "running", ThreadId.make(id), options.result ?? null),
    status,
    startedAt,
    completedAt,
  };
}

function captureRow(id: string, agents: ReadonlyArray<ReturnType<typeof captureAgent>>) {
  return {
    id,
    kind: "event" as const,
    continuesWorkLog: false,
    projectedItem: { item: agents[0]! },
    subagents: agents.map((item) => ({ item })),
  };
}

const LONG_REPORT =
  "All four tasks done and every test passes. T1 rewrote the cache on an ordered map so get and put refresh recency, T2 removed the stale exports, T3 split the reader, and T4 added the regression test.";

const CAPTURE_STATES = [
  {
    name: "working",
    expand: false,
    row: captureRow("capture-working", [
      captureAgent("w1", "Worker bench w1", "running", { startedMinutesAgo: 2.3 }),
      captureAgent("w2", "Worker bench w2", "running", { startedMinutesAgo: 2.2 }),
      captureAgent("w3", "Worker bench w3", "completed", {
        startedMinutesAgo: 2.3,
        ranMinutes: 1.85,
        result: LONG_REPORT,
      }),
    ]),
  },
  {
    name: "expanded-long",
    expand: true,
    row: captureRow("capture-expanded", [
      captureAgent(
        "l1",
        "Audit every renderer surface that reads provider status and report the ones that still parse terminal output",
        "running",
        { startedMinutesAgo: 4 },
      ),
      captureAgent("l2", "Worker bench w2", "waiting", { startedMinutesAgo: 3 }),
      captureAgent("l3", "Worker bench w3", "completed", {
        startedMinutesAgo: 4,
        ranMinutes: 2,
        result: LONG_REPORT,
      }),
    ]),
  },
  {
    name: "failed",
    expand: true,
    row: captureRow("capture-failed", [
      captureAgent("f1", "Worker bench w1", "completed", {
        startedMinutesAgo: 9,
        ranMinutes: 5.8,
        result: "Benchmarks pass on all three machines.",
      }),
      captureAgent("f2", "Worker bench w2", "failed", {
        startedMinutesAgo: 9,
        ranMinutes: 3,
        result: "The integration step could not reach the test database.",
      }),
    ]),
  },
  {
    name: "overflow-queued",
    expand: false,
    row: captureRow("capture-overflow", [
      captureAgent("o1", "Shard 1", "running", { startedMinutesAgo: 1 }),
      captureAgent("o2", "Shard 2", "running", { startedMinutesAgo: 1 }),
      captureAgent("o3", "Shard 3", "pending"),
      captureAgent("o4", "Shard 4", "pending"),
      captureAgent("o5", "Shard 5", "cancelled", { startedMinutesAgo: 1, ranMinutes: 0.2 }),
    ]),
  },
] as const;

const CAPTURE_CASES = (["light", "dark"] as const).flatMap((theme) =>
  [
    { name: "default", px: 720 },
    { name: "narrow", px: 340 },
  ].map((width) => ({ theme, width })),
);

describe.skipIf(!capturesEnabled)("subagent group captures", () => {
  it.each(CAPTURE_CASES)(
    "captures each state in $theme at $width.name width",
    async ({ theme, width }) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      vi.setSystemTime(CAPTURE_NOW);
      await page.viewport(width.px, 640);
      try {
        for (const state of CAPTURE_STATES) {
          await using screen = await render(
            <div style={{ padding: 16, background: "var(--content)" }}>
              <TimelineRowCtx
                value={
                  {
                    activeThreadEnvironmentId: ENVIRONMENT,
                    workGroupViewState: { scrollPositions: new Map(), expandedEntries: new Set() },
                    runs: [],
                    onOpenThread: () => {},
                    onToggleWorkEntry: () => {},
                  } as never
                }
              >
                <V2EventTimelineRow row={state.row as never} />
              </TimelineRowCtx>
            </div>,
          );
          if (state.expand) {
            await userEvent.click(screen.getByRole("button", { name: /subagents/ }));
          }
          await userEvent.unhover(screen.getByRole("button", { name: /subagents/ }));
          await page.screenshot({
            element: screen.container,
            path: `../../../../../.slice/captures/subagent-group-${state.name}-${theme}-${width.name}.png`,
          });
        }
      } finally {
        document.documentElement.classList.remove("dark");
        vi.useRealTimers();
      }
    },
  );
});
