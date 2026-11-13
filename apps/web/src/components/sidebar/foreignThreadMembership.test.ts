import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLayoutState,
  normalizeLayout,
  openLayoutTab,
  type LayoutTabContent,
} from "../../layout/layoutModel";
import { createLayoutWorkspaceNamed } from "../../layout/layoutWorkspaces";
import { membershipKeyOf, type ThreadMembershipState } from "../../layout/threadMembership";
import { planForeignThreadAssignments } from "./foreignThreadMembership";

const thread = (environmentId: string, id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    environmentId,
    deletedAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: id,
      sideChat: false,
    },
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const chat = (environmentId: string, id: string): LayoutTabContent => ({
  kind: "chat",
  target: {
    kind: "server",
    threadRef: scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(id)),
  },
});

const layout = (() => {
  let state = createLayoutState();
  state = createLayoutWorkspaceNamed(state, "One").state;
  state = normalizeLayout(openLayoutTab(state, chat("local", "anchor")));
  state = createLayoutWorkspaceNamed(state, "Two").state;
  return normalizeLayout(openLayoutTab(state, chat("remote", "open-in-two")));
})();
const [one, two] = layout.workspaces;

const state = (loaded: boolean, keys: string[] = []): ThreadMembershipState => ({
  loaded,
  byThread: new Map(keys.map((key) => [key, { workspaceId: one!.id, parentThreadId: null }])),
  occupied: new Set(),
});

const plan = (memberships: ThreadMembershipState, threads: EnvironmentThreadShell[]) =>
  planForeignThreadAssignments({ threads, memberships, layout, layoutEnvironmentId: "local" });

describe("planForeignThreadAssignments", () => {
  it("sends a thread of another environment to the workspace of its open tab, else the first", () => {
    expect(
      plan(state(true), [thread("remote", "open-in-two"), thread("remote", "no-tab")]),
    ).toEqual([
      { environmentId: "remote", threadId: "open-in-two", workspaceId: expect.any(String) },
      { environmentId: "remote", threadId: "no-tab", workspaceId: one!.id },
    ]);
    expect(plan(state(true), [thread("remote", "open-in-two")])[0]?.workspaceId).toBe(two!.id);
  });

  it("leaves the threads the layout server hosts to the server", () => {
    expect(plan(state(true), [thread("local", "t")])).toEqual([]);
  });

  it("skips a thread that has a workspace, a side thread and a deleted one", () => {
    expect(
      plan(state(true, [membershipKeyOf("remote", "placed")]), [
        thread("remote", "placed"),
        thread("remote", "side", { side: {} }),
        thread("remote", "gone", { deletedAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    ).toEqual([]);
  });

  it("plans nothing before the first snapshot", () => {
    expect(plan(state(false), [thread("remote", "t")])).toEqual([]);
  });
});
