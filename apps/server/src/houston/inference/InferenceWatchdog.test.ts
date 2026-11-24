import { describe, expect, it } from "vite-plus/test";

import { endsInLoop, makeInferenceWatchdog } from "./InferenceWatchdog.ts";

const feed = (
  watchdog: ReturnType<typeof makeInferenceWatchdog>,
  channel: "answer" | "reasoning" | "tool",
  text: string,
  chunk = 256,
) => {
  for (let index = 0; index < text.length; index += chunk) {
    const reason = watchdog.onDelta(channel, text.slice(index, index + chunk));
    if (reason !== undefined) return { reason, at: index + chunk };
  }
  return undefined;
};

describe("endsInLoop", () => {
  it("sees a short unit repeated over 4 KiB, and not text that only resembles itself", () => {
    expect(endsInLoop("Here is the list: " + "[],".repeat(2000))).toBe(true);
    const lines = Array.from({ length: 400 }, (_, index) => `  case ${index}: return ${index};\n`);
    expect(endsInLoop(lines.join(""))).toBe(false);
    expect(endsInLoop("ok ".repeat(100))).toBe(false);
  });
});

describe("makeInferenceWatchdog", () => {
  it("stops a looping answer at the second check that sees the loop", () => {
    const stopped = feed(makeInferenceWatchdog(), "answer", "Start. " + "[],".repeat(4000));
    expect(stopped?.reason).toBe("loop");
    // The first sighting at 4 KiB only arms it; one more 1 KiB check confirms.
    expect(stopped?.at).toBeGreaterThan(4096);
  });

  it("never treats tool arguments as a loop, and lets an answer end reasoning-only worries", () => {
    expect(feed(makeInferenceWatchdog(), "tool", "x = 1\n".repeat(4000))).toBeUndefined();
    const thinking = makeInferenceWatchdog({ reasoningLimitChars: 2048 });
    expect(
      feed(
        thinking,
        "reasoning",
        "Let me think about the next step carefully. ".repeat(3).padEnd(1500, "."),
      ),
    ).toBeUndefined();
    expect(
      feed(thinking, "reasoning", "Different thoughts, still none answered. ".repeat(20))?.reason,
    ).toBe("reasoning-limit");
    const answered = makeInferenceWatchdog({ reasoningLimitChars: 2048 });
    answered.onDelta("answer", "Done.");
    expect(
      feed(
        answered,
        "reasoning",
        Array.from({ length: 300 }, (_, index) => `Thought ${index} after answering. `).join(""),
      ),
    ).toBeUndefined();
  });
});
