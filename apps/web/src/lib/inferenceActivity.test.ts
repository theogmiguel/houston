import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@houston-app/contracts";
import { InferenceServerId } from "@houston-app/contracts/houston/inference";
import type { InferenceServerSnapshot } from "@houston-app/contracts/houston/inference";

import {
  formatThreadInferenceWait,
  sameThreadInferenceWait,
  threadInferenceWait,
} from "./inferenceActivity.ts";

const thread = ThreadId.make("thread-1");
const other = ThreadId.make("thread-2");
const server = (id: string, waiting: ReadonlyArray<{ threadId: ThreadId; position: number }>) =>
  ({
    id: InferenceServerId.make(id),
    displayName: id,
    gatewayQueue: {
      capacity: 2,
      active: [],
      waiting: waiting.map((entry) => ({
        threadId: entry.threadId,
        purpose: "interactive" as const,
        position: entry.position,
      })),
    },
  }) as unknown as InferenceServerSnapshot;

describe("threadInferenceWait", () => {
  it("finds the thread's closest queued request across servers", () => {
    const wait = threadInferenceWait(
      [
        server("a", [{ threadId: thread, position: 3 }]),
        server("b", [
          { threadId: thread, position: 1 },
          { threadId: other, position: 0 },
        ]),
      ],
      thread,
    );
    expect(wait).toEqual({ serverId: "b", serverName: "b", ahead: 1 });
  });

  it("returns null when no request of this thread is waiting", () => {
    expect(
      threadInferenceWait([server("a", [{ threadId: other, position: 0 }])], thread),
    ).toBeNull();
    expect(threadInferenceWait(null, thread)).toBeNull();
  });
});

describe("formatThreadInferenceWait", () => {
  it("names the server and the position", () => {
    expect(
      formatThreadInferenceWait({
        serverId: InferenceServerId.make("a"),
        serverName: "rtx",
        ahead: 2,
      }),
    ).toBe("Waiting for rtx · 2 ahead");
    expect(
      formatThreadInferenceWait({
        serverId: InferenceServerId.make("a"),
        serverName: "rtx",
        ahead: 0,
      }),
    ).toBe("Waiting for rtx · next");
  });

  it("compares by server and position", () => {
    expect(
      sameThreadInferenceWait(
        { serverId: InferenceServerId.make("a"), serverName: "rtx", ahead: 1 },
        { serverId: InferenceServerId.make("a"), serverName: "rtx", ahead: 1 },
      ),
    ).toBe(true);
    expect(
      sameThreadInferenceWait(
        { serverId: InferenceServerId.make("a"), serverName: "rtx", ahead: 1 },
        { serverId: InferenceServerId.make("a"), serverName: "rtx", ahead: 2 },
      ),
    ).toBe(false);
  });
});
