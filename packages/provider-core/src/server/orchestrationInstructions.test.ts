import { assert, describe, it } from "@effect/vitest";

import {
  HOUSTON_DEVICE_TOOL_INSTRUCTIONS,
  HOUSTON_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  HOUSTON_ORCHESTRATION_INSTRUCTIONS,
  houstonAcpPromptWithInstructions,
  houstonOrchestrationPrompt,
  houstonOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Houston device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(HOUSTON_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(HOUSTON_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__houston__device_list,mcp__houston__device_open,mcp__houston__device_screenshot,mcp__houston__device_close`.";
    assert.include(HOUSTON_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      HOUSTON_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      HOUSTON_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      HOUSTON_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      HOUSTON_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(houstonOrchestrationSystemPrompt(true, true), HOUSTON_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(houstonOrchestrationSystemPrompt(true, false), "## Houston devices");
    assert.isUndefined(houstonOrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      houstonOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasHoustonMcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), HOUSTON_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## Houston devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      houstonOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasHoustonMcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), HOUSTON_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), HOUSTON_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = {
      interactionMode: "default",
      hasHoustonMcp: true,
      hasDeviceTools: false,
    } as const;
    const withDevices = houstonAcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, HOUSTON_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      houstonAcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(
      houstonAcpPromptWithInstructions({ prompt: "Hi.", state }),
      "## Houston devices",
    );
  });
});
