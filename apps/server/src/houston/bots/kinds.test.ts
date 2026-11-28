import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";

import {
  policyFor,
  REFUSED_HOUSTON_TOOLS,
  UNATTENDED_BUILTIN_TOOLS,
  UNATTENDED_HOUSTON_TOOLS,
} from "./kinds.ts";

const bot = {
  askedMode: "approval-required",
  unattendedFullAccess: false,
  maxMinutes: 20,
} as const;
const TIMERS = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger"];
const SCHEDULING = [
  "mcp__houston__schedule_task",
  "mcp__houston__delete_scheduled_task",
  "mcp__houston__run_scheduled_task_now",
];

describe("the asked kind", () => {
  it("keeps the thread's own mode, asks a person as today, and refuses timers, scheduling and memory", () => {
    const policy = policyFor({ kind: "asked", bot });
    assert.strictEqual(policy.kind, "asked");
    assert.isUndefined(policy.runtimeMode);
    assert.isFalse(policy.neverAsk);
    assert.isUndefined(policy.maxMinutes);
    assert.deepStrictEqual(policy.rules, { connectorTools: "all", gh: "any" });
    assert.sameMembers([...policy.refusedTools], [...TIMERS, ...SCHEDULING]);
  });

  it("is the same whatever the bot's full-access switch says", () => {
    assert.deepStrictEqual(
      policyFor({ kind: "asked", bot: { ...bot, unattendedFullAccess: true } }),
      policyFor({ kind: "asked", bot }),
    );
  });
});

describe("the unattended kind", () => {
  it("runs in Auto, never asks, has the bot's time limit and reads connectors only", () => {
    const policy = policyFor({ kind: "unattended", bot });
    assert.strictEqual(policy.runtimeMode, "auto");
    assert.isTrue(policy.neverAsk);
    assert.strictEqual(policy.maxMinutes, 20);
    assert.deepStrictEqual(policy.rules, {
      builtinTools: [...UNATTENDED_BUILTIN_TOOLS],
      connectorTools: "reads",
      houstonTools: [...UNATTENDED_HOUSTON_TOOLS],
      gh: "reads",
    });
  });

  it("runs in full access only when the bot's switch is on", () => {
    assert.strictEqual(
      policyFor({ kind: "unattended", bot: { ...bot, unattendedFullAccess: true } }).runtimeMode,
      "full-access",
    );
  });

  it("decides every built-in tool the SDK names: allowed by name, otherwise refused", () => {
    const policy = policyFor({ kind: "unattended", bot });
    for (const name of BUILTIN_TOOL_NAMES) {
      const allowed = UNATTENDED_BUILTIN_TOOLS.includes(name);
      assert.strictEqual(policy.refusedTools.includes(name), !allowed, name);
    }
    for (const name of [...TIMERS, ...SCHEDULING, "Task", "Monitor", "Agent", "AskUserQuestion"]) {
      assert.include(policy.refusedTools, name);
    }
  });

  it("allows exactly the listed Houston tools, the result tool among them, and no scheduling tool", () => {
    assert.include(UNATTENDED_HOUSTON_TOOLS, "houston_bot_result");
    assert.lengthOf(UNATTENDED_HOUSTON_TOOLS, 13);
    for (const name of REFUSED_HOUSTON_TOOLS) {
      assert.notInclude(UNATTENDED_HOUSTON_TOOLS, name);
    }
  });
});
