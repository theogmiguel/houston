import { createRef, type ComponentProps } from "react";
import { userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@houston-app/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";

const state = vi.hoisted(() => ({
  start: vi.fn(),
  complete: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("../../state/mcpSignIn", () => ({
  startMcpSignIn: { label: "mcp-sign-in-start" },
  completeMcpSignIn: { label: "mcp-sign-in-complete" },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => {
    if (command.label === "mcp-sign-in-start") return state.start;
    if (command.label === "mcp-sign-in-complete") return state.complete;
    return async () => AsyncResult.success(undefined);
  },
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-mcp-sign-in");
const PROVIDER_THREAD_ID = ProviderThreadId.make("provider-thread-mcp-sign-in");
const CREATED_AT = "2026-03-17T19:12:28.000Z";
const SIGNED_IN_AT = "2026-03-17T19:13:00.000Z";
const AUTH_URL = "https://auth.example.test/start?state=abc";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

function noticeEntry(input: {
  readonly id: string;
  readonly server?: string;
  readonly message?: string;
  readonly createdAt?: string;
  readonly ordinal?: number;
}): Entry {
  const server = input.server;
  const message =
    input.message ?? `The ${server ?? "linear"} MCP server needs a sign-in before Claude can use it.`;
  const source: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: THREAD_ID,
    sourceItemId: TurnItemId.make(input.id),
    item: {
      id: TurnItemId.make(input.id),
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: PROVIDER_THREAD_ID,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: input.ordinal ?? 1,
      status: "completed",
      title: server ? `MCP server ${server} needs a sign-in` : null,
      startedAt: DateTime.makeUnsafe(input.createdAt ?? CREATED_AT),
      completedAt: DateTime.makeUnsafe(input.createdAt ?? CREATED_AT),
      updatedAt: DateTime.makeUnsafe(input.createdAt ?? CREATED_AT),
      type: "system_notice",
      message,
      ...(server ? { mcpSignIn: { server } } : {}),
    },
  };
  const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [source],
    optimisticMessages: [],
  });
  if (entry === undefined) throw new Error("Expected a notice entry");
  return entry;
}

async function renderTimeline(entries: ReadonlyArray<Entry>) {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(<MessagesTimeline {...baseProps()} timelineEntries={entries} />, {
    container,
  });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function failure(error: unknown) {
  return AsyncResult.failure(Cause.fail(error));
}

function resetState() {
  state.start.mockReset();
  state.complete.mockReset();
  state.openExternal.mockReset();
  state.openExternal.mockResolvedValue(true);
  state.start.mockResolvedValue(
    AsyncResult.success({ authorizationUrl: AUTH_URL, signedInAt: null }),
  );
}

describe("MCP sign-in notice", () => {
  it("opens the sign-in page and asks for the address it ended on", async () => {
    resetState();
    await using screen = await renderTimeline([noticeEntry({ id: "notice-1", server: "linear" })]);

    expect(screen.text()).toContain(
      "The linear MCP server needs a sign-in before Claude can use it.",
    );
    await userEvent.click(screen.button("Sign in"));

    await vi.waitFor(() => expect(state.openExternal).toHaveBeenCalledWith(AUTH_URL));
    expect(state.start).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        threadId: THREAD_ID,
        providerThreadId: PROVIDER_THREAD_ID,
        server: "linear",
      },
    });
    const field = screen.getByRole("textbox", { name: "Address the sign-in ended on" });
    await expect.element(field).toBeVisible();
    expect((screen.button("Continue") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.buttons("Open again")).toHaveLength(1);
  });

  it("keeps the pasted address but says what shape was expected when it is rejected", async () => {
    resetState();
    const pasted = "https://linear.app/settings/api";
    state.complete.mockResolvedValue(
      failure({
        _tag: "HoustonMcpSignInError",
        kind: "callback-rejected",
        server: "linear",
        message: "The callback URL does not belong to this sign-in.",
      }),
    );
    await using screen = await renderTimeline([noticeEntry({ id: "notice-1", server: "linear" })]);

    await userEvent.click(screen.button("Sign in"));
    const field = screen.getByRole("textbox", { name: "Address the sign-in ended on" });
    await userEvent.type(field.element(), pasted);
    await userEvent.click(screen.button("Continue"));

    await expect
      .element(screen.getByText("Expected the http://127.0.0.1 address the sign-in ended on."))
      .toBeVisible();
    expect((field.element() as HTMLInputElement).value).toBe(pasted);
    expect(screen.text()).not.toContain(pasted);
  });

  it("collapses the notice and marks an earlier notice for the same server signed in", async () => {
    resetState();
    state.complete.mockResolvedValue(
      AsyncResult.success({ signedInAt: SIGNED_IN_AT }),
    );
    await using screen = await renderTimeline([
      noticeEntry({
        id: "notice-earlier",
        server: "linear",
        createdAt: "2026-03-17T19:10:00.000Z",
        ordinal: 1,
      }),
      noticeEntry({
        id: "notice-later",
        server: "linear",
        createdAt: "2026-03-17T19:11:00.000Z",
        ordinal: 2,
      }),
    ]);

    const signInButtons = screen.buttons("Sign in");
    expect(signInButtons).toHaveLength(2);
    await userEvent.click(signInButtons[1]!);
    const field = screen.getByRole("textbox", { name: "Address the sign-in ended on" });
    await userEvent.type(field.element(), "http://127.0.0.1:53117/callback?code=abc&state=abc");
    await userEvent.click(screen.button("Continue"));

    await vi.waitFor(() => {
      expect(screen.text().match(/linear\s+signed in/g) ?? []).toHaveLength(2);
    });
    expect(screen.buttons("Sign in")).toHaveLength(0);
  });

  it("shows progress and locks the field while the address is checked", async () => {
    resetState();
    let settle: (result: unknown) => void = () => {};
    state.complete.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await using screen = await renderTimeline([noticeEntry({ id: "notice-1", server: "linear" })]);

    await userEvent.click(screen.button("Sign in"));
    const field = screen.getByRole("textbox", { name: "Address the sign-in ended on" });
    await userEvent.type(field.element(), "http://127.0.0.1:53117/callback?code=abc");
    await userEvent.click(screen.button("Continue"));

    await expect.element(screen.getByRole("button", { name: /Signing in/ })).toBeVisible();
    expect((field.element() as HTMLInputElement).readOnly).toBe(true);

    settle(AsyncResult.success({ signedInAt: SIGNED_IN_AT }));
    await expect.element(screen.getByText(/linear signed in/)).toBeVisible();
  });

  it("says the session ended and offers no action", async () => {
    resetState();
    state.start.mockResolvedValue(
      failure({
        _tag: "HoustonMcpSignInError",
        kind: "session-ended",
        server: "sentry",
        message: "Thread thread-mcp-sign-in's provider session has ended.",
      }),
    );
    await using screen = await renderTimeline([noticeEntry({ id: "notice-1", server: "sentry" })]);

    await userEvent.click(screen.button("Sign in"));

    await expect
      .element(screen.getByText("This session ended, so sign-in can't start."))
      .toBeVisible();
    expect(screen.buttons("Sign in")).toHaveLength(0);
    expect(screen.buttons("Continue")).toHaveLength(0);
  });

  it("stays plain text naming the provider when it does not support sign-in", async () => {
    resetState();
    state.start.mockResolvedValue(
      failure({
        _tag: "HoustonMcpSignInError",
        kind: "unsupported-provider",
        server: "linear",
        message:
          "The codex provider does not support MCP sign-in (capability: MCP sign-in), so linear cannot be signed in from Houston.",
      }),
    );
    await using screen = await renderTimeline([noticeEntry({ id: "notice-1", server: "linear" })]);

    await userEvent.click(screen.button("Sign in"));

    await expect
      .element(screen.getByText(/The codex provider does not support MCP sign-in/))
      .toBeVisible();
    expect(screen.buttons("Sign in")).toHaveLength(0);
  });

  it("leaves a notice without mcpSignIn exactly as it was", async () => {
    resetState();
    await using screen = await renderTimeline([
      noticeEntry({ id: "notice-1", message: "Claude changed its safety mode." }),
    ]);

    expect(screen.text()).toContain("Claude changed its safety mode.");
    expect(screen.buttons("Sign in")).toHaveLength(0);
    expect(screen.text()).not.toContain("Paste address");
    expect(state.start).not.toHaveBeenCalled();
  });

  it("keeps each server's sign-in independent", async () => {
    resetState();
    state.complete.mockResolvedValue(AsyncResult.success({ signedInAt: SIGNED_IN_AT }));
    await using screen = await renderTimeline([
      noticeEntry({ id: "notice-linear", server: "linear", ordinal: 1 }),
      noticeEntry({ id: "notice-sentry", server: "sentry", ordinal: 2 }),
    ]);

    await userEvent.click(screen.buttons("Sign in")[0]!);
    expect(screen.getByRole("textbox", { name: "Address the sign-in ended on" })).toBeDefined();
    const field = screen.getByRole("textbox", { name: "Address the sign-in ended on" });
    await userEvent.type(field.element(), "http://127.0.0.1:53117/callback?code=abc");
    await userEvent.click(screen.button("Continue"));

    await vi.waitFor(() => {
      expect(screen.text()).toContain("linear signed in");
    });
    expect(screen.buttons("Sign in")).toHaveLength(1);
    expect(screen.text()).toContain("The sentry MCP server needs a sign-in");
  });
});
