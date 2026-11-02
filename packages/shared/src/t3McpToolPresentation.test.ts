import { describe, expect, it } from "vite-plus/test";

import {
  HOUSTON_MCP_TOOL_NAMES,
  resolveT3McpSummaryAction,
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
} from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("recognizes every Houston tool across provider prefixes and completion suffixes", () => {
    for (const tool of HOUSTON_MCP_TOOL_NAMES) {
      const presentation = resolveT3McpToolPresentation(tool);
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
        expect(resolveT3McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT3McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveT3McpToolPresentation("houston-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveT3McpToolPresentation("houston-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });
});

describe("resolveT3McpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveT3McpToolDefinition("mcp__houston__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveT3McpToolDefinition("preview_type")?.labels);
    expect(
      resolveT3McpToolDefinition("houston_thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveT3McpToolDefinition("houston_thread_fork")?.displayName);
    expect(resolveT3McpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveT3McpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveT3McpSummaryAction("mcp__houston__houston_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveT3McpSummaryAction("houston_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveT3McpSummaryAction("houston_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveT3McpSummaryAction("houston_thread_configure", {})).toBe("thread-configuration");
    expect(resolveT3McpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveT3McpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
