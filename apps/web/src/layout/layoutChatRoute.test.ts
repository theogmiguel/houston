import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import { layoutChatRoute } from "./layoutChatRoute";

describe("layoutChatRoute", () => {
  it("routes a server thread's chat to its thread route", () => {
    const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));
    expect(layoutChatRoute({ kind: "chat", target: { kind: "server", threadRef } })).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "t1" },
    });
  });

  it("routes a draft's chat to its draft route", () => {
    expect(
      layoutChatRoute({ kind: "chat", target: { kind: "draft", draftId: DraftId.make("d1") } }),
    ).toEqual({ to: "/draft/$draftId", params: { draftId: "d1" } });
  });
});
