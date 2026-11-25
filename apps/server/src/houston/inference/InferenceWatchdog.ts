import type { DeltaChannel } from "./inferenceUsage.ts";

/** Why the gateway stopped a reply: it repeated itself, only thought, or went quiet. */
export type WatchdogReason = "loop" | "reasoning-limit" | "idle";

// A loop is an exact repeat: a unit of 64-1024 characters (a shorter one is counted as its
// smallest multiple of 64) back to back at least 8 times and over at least 4 KiB, seen at two
// checks in a row. Checks run each time a channel grows by 1 KiB, over its last 16 KiB.
const WINDOW_CHARS = 16 * 1024;
const CHECK_EVERY_CHARS = 1024;
const MIN_UNIT = 64;
const MAX_UNIT = 1024;
const MIN_REPEATS = 8;
const MIN_SPAN = 4 * 1024;
const PROBE_CHARS = 64;
// Without an answer or a tool call, this much reasoning is a model thinking in circles.
const DEFAULT_REASONING_LIMIT_CHARS = 128 * 1024;
// Ahead of the first generated text a long prompt may still be prefilling.
export const FIRST_CONTENT_TIMEOUT_MS = 300_000;
export const IDLE_TIMEOUT_MS = 120_000;

/** Whether `text` ends in one unit repeated back to back over the loop thresholds. */
export function endsInLoop(text: string): boolean {
  const length = text.length;
  if (length < MIN_SPAN) return false;
  const probe = text.slice(length - PROBE_CHARS);
  // The nearest earlier copy of the tail gives the repeat's period.
  const previous = text.lastIndexOf(probe, length - PROBE_CHARS - 1);
  if (previous < 0) return false;
  const period = length - PROBE_CHARS - previous;
  const unit = period < MIN_UNIT ? period * Math.ceil(MIN_UNIT / period) : period;
  if (unit > MAX_UNIT) return false;
  const span = Math.max(unit * MIN_REPEATS, MIN_SPAN);
  if (span > length) return false;
  for (let index = length - span + unit; index < length; index++) {
    if (text.charCodeAt(index) !== text.charCodeAt(index - unit)) return false;
  }
  return true;
}

export interface InferenceWatchdog {
  /** Feeds one piece of generated text; returns why to stop, once there is a reason. */
  readonly onDelta: (channel: DeltaChannel, text: string) => WatchdogReason | undefined;
}

/** Tool arguments are never checked for loops: a written file may well repeat itself. */
export function makeInferenceWatchdog(options?: {
  readonly reasoningLimitChars?: number;
}): InferenceWatchdog {
  const reasoningLimit = options?.reasoningLimitChars ?? DEFAULT_REASONING_LIMIT_CHARS;
  const windows = { answer: "", reasoning: "" };
  const grown = { answer: 0, reasoning: 0 };
  const suspected = { answer: false, reasoning: false };
  let reasoningChars = 0;
  let answered = false;

  const check = (channel: "answer" | "reasoning", text: string): boolean => {
    const next = windows[channel] + text;
    windows[channel] = next.length > WINDOW_CHARS ? next.slice(next.length - WINDOW_CHARS) : next;
    grown[channel] += text.length;
    if (grown[channel] < CHECK_EVERY_CHARS) return false;
    grown[channel] = 0;
    const looping = endsInLoop(windows[channel]);
    const confirmed = looping && suspected[channel];
    suspected[channel] = looping;
    return confirmed;
  };

  return {
    onDelta: (channel, text) => {
      if (channel === "tool") {
        answered = true;
        return undefined;
      }
      if (channel === "answer") answered = true;
      else reasoningChars += text.length;
      if (check(channel, text)) return "loop";
      return !answered && reasoningChars > reasoningLimit ? "reasoning-limit" : undefined;
    },
  };
}
