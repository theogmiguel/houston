import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

const ENVIRONMENT = EnvironmentId.make("environment");
const PARENT = ThreadId.make("parent");
const RENDERER = ThreadId.make("renderer");
const CONTRACTS = ThreadId.make("contracts");

function subagentItem(
  id: string,
  title: string,
  status: "completed" | "running",
  childThreadId: ThreadId,
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
    result: null,
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
  it("summarises, expands and opens a subagent row", async () => {
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

    const summary = screen.getByRole("button", {
      name: "Started 2 subagents · 1 running",
    });
    await expect.element(summary).toBeVisible();
    await expect.element(screen.getByText("Review: web renderer")).not.toBeInTheDocument();

    await userEvent.click(summary);
    await expect.element(screen.getByText("Review: web renderer")).toBeVisible();
    await expect.element(screen.getByText("Review: server and contracts")).toBeVisible();
    await expect.element(screen.getByText("Running")).toBeVisible();
    await expect.element(screen.getByText("Ready")).toBeVisible();
    expect(onToggleWorkEntry).toHaveBeenCalledWith("subagent-group-row", false);

    await userEvent.click(
      screen.getByRole("button", { name: "Open Review: web renderer" }),
    );
    expect(onOpenThread).toHaveBeenCalledWith(RENDERER);

    await userEvent.click(summary);
    await expect.element(screen.getByText("Review: web renderer")).not.toBeInTheDocument();
  });
});
