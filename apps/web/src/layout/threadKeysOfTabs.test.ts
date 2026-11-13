import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import { buildLayout } from "./layoutFixtures";
import { threadKeysOfTabs } from "./layoutThreadRef";
import { type LayoutState } from "./layoutModel";

const env = EnvironmentId.make("local");
const keyOf = (name: string) => scopedThreadKey(scopeThreadRef(env, ThreadId.make(name)));

function withSurface(layout: LayoutState): LayoutState {
  const pane = layout.workspaces[0]!.columns[0]!.panes[0]!;
  pane.tabs.push({
    id: "files",
    content: {
      kind: "surface",
      surfaceId: "files",
      threadRef: scopeThreadRef(env, ThreadId.make("owner")),
    },
  });
  return layout;
}

describe("threadKeysOfTabs", () => {
  it("maps a server chat to its thread and a surface tab to its owner", () => {
    const layout = withSurface(buildLayout([[[["a", "b"]], [["c"]]]]));
    expect(threadKeysOfTabs(layout, new Set(["a", "files"]))).toEqual(
      new Set([keyOf("a"), keyOf("owner")]),
    );
  });

  it("skips a launcher, a draft, and an id no tab has", () => {
    const layout = buildLayout([[[["a"]]]]);
    layout.workspaces[0]!.columns[0]!.panes[0]!.tabs.push(
      { id: "launch", content: { kind: "launcher", id: "l1", context: null } },
      {
        id: "draft",
        content: { kind: "chat", target: { kind: "draft", draftId: DraftId.make("d") } },
      },
    );
    expect(threadKeysOfTabs(layout, new Set(["launch", "draft", "ghost"]))).toEqual(new Set());
  });
});
