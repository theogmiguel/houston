import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "../baseSchemas.ts";

/** What the server could not read this sample; the row omits that line instead of guessing. */
export const HoustonThreadMemoryUnreadable = Schema.Literals(["machine", "thread"]);
export type HoustonThreadMemoryUnreadable = typeof HoustonThreadMemoryUnreadable.Type;

export const HoustonThreadMemoryMachine = Schema.Struct({
  totalBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  leftPercent: NonNegativeInt,
});
export type HoustonThreadMemoryMachine = typeof HoustonThreadMemoryMachine.Type;

export const HoustonThreadMemoryThread = Schema.Struct({
  residentBytes: NonNegativeInt,
  subagentCount: NonNegativeInt,
});
export type HoustonThreadMemoryThread = typeof HoustonThreadMemoryThread.Type;

export const HoustonThreadMemorySample = Schema.Struct({
  sampledAt: NonNegativeInt,
  machine: Schema.NullOr(HoustonThreadMemoryMachine),
  thread: Schema.NullOr(HoustonThreadMemoryThread),
  unreadable: Schema.Array(HoustonThreadMemoryUnreadable),
});
export type HoustonThreadMemorySample = typeof HoustonThreadMemorySample.Type;

export const HoustonThreadMemoryInput = Schema.Struct({
  threadId: ThreadId,
});
export type HoustonThreadMemoryInput = typeof HoustonThreadMemoryInput.Type;
