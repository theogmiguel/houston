import { describe, expect, it } from "vite-plus/test";

import {
  HOUSTON_MCP_TOOL_NAMES,
  resolveHoustonMcpSummaryAction,
  resolveHoustonMcpToolDefinition,
  resolveHoustonMcpToolPresentation,
} from "./houstonMcpToolPresentation.ts";

describe("resolveHoustonMcpToolPresentation", () => {
  it("recognizes every Houston tool across provider prefixes and completion suffixes", () => {
    for (const tool of HOUSTON_MCP_TOOL_NAMES) {
      const presentation = resolveHoustonMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__houston__",
        "mcp__houston_code__",
        "mcp__houston__",
        "houston.",
        "houston_code/",
        "houston:",
        "mcp_houston_",
        "Houston ",
        "houston · ",
      ]) {
        expect(resolveHoustonMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveHoustonMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveHoustonMcpToolPresentation("houston-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveHoustonMcpToolPresentation("houston-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });
});

describe("resolveHoustonMcpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveHoustonMcpToolDefinition("mcp__houston__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveHoustonMcpToolDefinition("preview_type")?.labels);
    expect(
      resolveHoustonMcpToolDefinition("houston_thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveHoustonMcpToolDefinition("houston_thread_fork")?.displayName);
    expect(resolveHoustonMcpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveHoustonMcpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveHoustonMcpSummaryAction("mcp__houston__houston_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveHoustonMcpSummaryAction("houston_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveHoustonMcpSummaryAction("houston_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveHoustonMcpSummaryAction("houston_thread_configure", {})).toBe(
      "thread-configuration",
    );
    expect(resolveHoustonMcpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveHoustonMcpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
