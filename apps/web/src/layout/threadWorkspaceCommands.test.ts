import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  createLayoutState,
  findLayoutTab,
  findLayoutTabByContent,
  normalizeLayout,
  openLayoutTab,
} from "./layoutModel";
import { openLayoutLauncherInWorkspaceAction } from "./layoutWorkspaceActions";
import { useLayoutStore } from "./layoutStore";
import { reportFocus, layoutWorkspacesEnvironment } from "./layoutSyncRuntime";
import { createLayoutWorkspaceNamed } from "./layoutWorkspaces";
import { claimWorkspaceForNewThread } from "./threadWorkspaceCommands";

const phone = vi.hoisted(() => ({ isPhone: false }));
vi.mock("../mobile/usePhone", async (original) => ({
  ...(await original<object>()),
  isPhoneViewport: () => phone.isPhone,
}));

const environmentId = EnvironmentId.make("env-1");

vi.mock("./layoutSyncRuntime", async (original) => ({
  ...(await original<object>()),
  layoutEnvironmentId: () => "env-1",
  flushLayoutSync: async () => {},
}));
const threadId = ThreadId.make("new-thread");
const draftId = DraftId.make("draft-1");

const assign = vi.fn();
const setFocus = vi.fn();

beforeEach(() => {
  assign.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  setFocus.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  vi.spyOn(layoutWorkspacesEnvironment.assignThread, "run").mockImplementation(assign);
  vi.spyOn(layoutWorkspacesEnvironment.setFocus, "run").mockImplementation(setFocus);
  phone.isPhone = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  useLayoutStore.getState().reset();
  useComposerDraftStore.setState({ draftThreadsByThreadKey: {} });
});

/** Two workspaces; the draft's tab is open in the second. */
function seedDraftInSecondWorkspace(): string {
  let state = createLayoutState();
  state = createLayoutWorkspaceNamed(state, "One").state;
  state = normalizeLayout(
    openLayoutTab(state, {
      kind: "chat",
      target: { kind: "draft", draftId: DraftId.make("other") },
    }),
  );
  state = createLayoutWorkspaceNamed(state, "Two").state;
  state = normalizeLayout(
    openLayoutTab(state, { kind: "chat", target: { kind: "draft", draftId } }),
  );
  useLayoutStore.setState({ layout: state });
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: { [draftId]: { environmentId, threadId } } as never,
  });
  return state.workspaces[1]!.id;
}

describe("claimWorkspaceForNewThread", () => {
  it("records the workspace holding the draft's tab as the new thread's workspace", async () => {
    const workspaceId = seedDraftInSecondWorkspace();
    await claimWorkspaceForNewThread({ environmentId, threadId });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0]![1]).toMatchObject({
      input: { environmentId, threadId, workspaceId },
    });
  });

  it("writes nothing for a draft that has no tab, such as one closed before its first message", async () => {
    seedDraftInSecondWorkspace();
    useLayoutStore.setState({ layout: createLayoutState() });
    await claimWorkspaceForNewThread({ environmentId, threadId });
    expect(assign).not.toHaveBeenCalled();
  });

  it("writes nothing for a thread that is not a draft", async () => {
    seedDraftInSecondWorkspace();
    await claimWorkspaceForNewThread({ environmentId, threadId: ThreadId.make("not-a-draft") });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("reportFocus", () => {
  const focusSecondWorkspace = () => {
    const workspaceId = seedDraftInSecondWorkspace();
    useLayoutStore.setState({ layoutLoaded: true });
    useLayoutStore.getState().focusWorkspace(useLayoutStore.getState().layout.workspaces[0]!.id);
    const stop = reportFocus(environmentId);
    useLayoutStore.getState().focusWorkspace(workspaceId);
    return { stop, workspaceId };
  };

  it("tells the server which workspace the window focuses", () => {
    const { stop, workspaceId } = focusSecondWorkspace();
    stop();
    expect(setFocus).toHaveBeenCalledTimes(1);
    expect(setFocus.mock.calls[0]![1]).toMatchObject({ input: { workspaceId } });
  });

  it("stays silent on the phone shell", () => {
    phone.isPhone = true;
    const { stop } = focusSecondWorkspace();
    stop();
    expect(setFocus).not.toHaveBeenCalled();
  });
});

describe("a thread started from a workspace heading", () => {
  it("opens its launcher in that workspace without moving focus, and the thread claims that workspace", async () => {
    const secondId = seedDraftInSecondWorkspace();
    const firstId = useLayoutStore.getState().layout.workspaces[0]!.id;
    useLayoutStore.getState().focusWorkspace(firstId);

    openLayoutLauncherInWorkspaceAction(secondId);
    const layout = useLayoutStore.getState().layout;
    const launcher = findLayoutTab(layout, (tab) => tab.content.kind === "launcher");
    expect(launcher?.workspace.id).toBe(secondId);

    // The launcher turns into the new thread's draft tab, which sits in the same workspace.
    const draft = findLayoutTabByContent(layout, {
      kind: "chat",
      target: { kind: "draft", draftId },
    });
    expect(draft?.workspace.id).toBe(secondId);
    await claimWorkspaceForNewThread({ environmentId, threadId });
    expect(assign.mock.calls[0]![1]).toMatchObject({ input: { workspaceId: secondId } });
  });
});
