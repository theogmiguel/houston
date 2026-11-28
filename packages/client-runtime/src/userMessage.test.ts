import { describe, expect, it } from "vite-plus/test";

import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@houston-app/shared/composerContextReferences";
import { compactionReasonTitle, resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("hides the prompt that stands in for an attachment-only message", () => {
    for (const text of [
      ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", text })).toEqual({
        text: "",
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });
  it("attributes older server-sent restart continuations to Houston, not another agent", () => {
    const text = "Note: the Houston server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "houston" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});

describe("compactionReasonTitle", () => {
  it("names the reason and the context size before compacting", () => {
    expect(compactionReasonTitle("beforeCacheExpires", 268_000)).toBe(
      "Compacted before the cache expired: 268K",
    );
    expect(compactionReasonTitle("onReturn", 241_000)).toBe("Compacted when you returned: 241K");
    expect(compactionReasonTitle("onRequest", undefined)).toBe("Compacted on request");
  });

  it("names what woke a stale thread before its turn started", () => {
    expect(compactionReasonTitle("wake:delegatedResult", 318_000)).toBe(
      "Compacted before a delegated result: 318K",
    );
    expect(compactionReasonTitle("wake:scheduledTask", undefined)).toBe(
      "Compacted before a scheduled task",
    );
  });
});
