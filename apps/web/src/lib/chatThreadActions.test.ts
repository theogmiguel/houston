import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  resolveNewThreadModelSelectionOverride,
  startNewThreadFromContext,
} from "./chatThreadActions";
import { subscribeComposerFocus } from "./composerFocus";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});

function stubWindowForComposerFocus(): Disposable {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: new EventTarget(),
    configurable: true,
    writable: true,
  });
  return {
    [Symbol.dispose]() {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

const projectRef = scopeProjectRef(
  EnvironmentId.make("environment-local"),
  ProjectId.make("project-1"),
);

describe("startNewThreadFromContext", () => {
  it("focuses the composer of a draft that is already open", async () => {
    using _window = stubWindowForComposerFocus();
    const focus = vi.fn();
    using _subscription = { [Symbol.dispose]: subscribeComposerFocus(focus) };

    const started = await startNewThreadFromContext({
      activeDraftThread: {
        environmentId: projectRef.environmentId,
        projectId: projectRef.projectId,
      },
      activeThread: undefined,
      defaultProjectRef: null,
      handleNewThread: vi.fn(async () => undefined),
    });

    expect(started).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not ask for focus when no project can start a thread", async () => {
    using _window = stubWindowForComposerFocus();
    const focus = vi.fn();
    using _subscription = { [Symbol.dispose]: subscribeComposerFocus(focus) };

    const started = await startNewThreadFromContext({
      activeDraftThread: null,
      activeThread: undefined,
      defaultProjectRef: null,
      handleNewThread: vi.fn(async () => undefined),
    });

    expect(started).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
