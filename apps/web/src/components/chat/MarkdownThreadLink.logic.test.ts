import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadLinkLookup, type ThreadLinkTitlesLookup } from "./MarkdownThreadLink.logic";

const environmentId = EnvironmentId.make("local");
const link = { environmentId, threadId: ThreadId.make("older") };
const ref = { environmentId, threadId: link.threadId };
const base = {
  link,
  messageEnvironmentId: environmentId,
  candidates: [ref],
  label: null,
};
const lookup = (
  data: Readonly<Record<string, string>> | null,
  isSuccess: boolean,
  isPending: boolean,
): ThreadLinkTitlesLookup => ({ data, isSuccess, isPending });

describe("resolving a chat link the shells leave out", () => {
  it("finds the thread's title on its environment and targets that thread", () => {
    expect(
      resolveThreadLinkLookup({
        ...base,
        lookup: lookup({ older: "Older settled thread" }, true, false),
      }),
    ).toEqual({ kind: "found", ref, title: "Older settled thread" });
  });

  it("reports the unavailable label only when the lookup confirms the thread is gone", () => {
    expect(
      resolveThreadLinkLookup({
        ...base,
        lookup: lookup({}, true, false),
      }),
    ).toEqual({
      kind: "unavailable",
      label: "Thread no longer available",
      tooltip: "Thread no longer available",
    });
  });

  it("stays pending instead of claiming the thread is gone while the lookup runs", () => {
    expect(
      resolveThreadLinkLookup({
        ...base,
        lookup: lookup(null, false, true),
      }),
    ).toEqual({
      kind: "pending",
      label: "Loading thread…",
      tooltip: "Loading thread…",
    });
  });

  it("keeps a written label while the lookup runs", () => {
    expect(
      resolveThreadLinkLookup({
        ...base,
        label: "Old title",
        lookup: lookup(null, false, true),
      }),
    ).toEqual({
      kind: "pending",
      label: "Old title",
      tooltip: "Loading thread…",
    });
  });

  it("does not claim a thread is gone after a failed lookup", () => {
    expect(
      resolveThreadLinkLookup({
        ...base,
        lookup: lookup(null, false, false),
      }),
    ).toMatchObject({ kind: "pending", label: "Loading thread…" });
  });
});
