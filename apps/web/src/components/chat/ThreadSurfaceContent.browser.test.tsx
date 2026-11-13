import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const captured = vi.hoisted(() => ({ props: null as null | Record<string, any> }));

vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: Atom.make([]),
  primaryServerAvailableEditorsAtom: Atom.make([]),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ serverConfig: {} }),
}));
vi.mock("../../state/entities", () => ({
  useQuietThreadShell: () => null,
  useProject: () => null,
}));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../hooks/useRightPanelSurfaceClose", () => ({
  useRightPanelSurfaceClose: () => ({ closeSurface: () => {} }),
}));
vi.mock("../terminal/useRightPanelTerminalActions", () => ({
  useRightPanelTerminalActions: () => ({
    splitPanelTerminalStable: () => {},
    splitPanelTerminalVerticalStable: () => {},
    addTerminalSurfaceStable: () => {},
    activatePanelTerminalStable: () => {},
    closePanelTerminalStable: () => {},
  }),
}));
vi.mock("../terminal/useTerminalLabels", () => ({ useTerminalLabels: () => new Map() }));
vi.mock("./RightPanelSurfaceContent", () => ({
  RightPanelSurfaceContent: (props: Record<string, any>) => {
    captured.props = props;
    return <div data-testid="surface" data-surface-id={props.surface?.id} />;
  },
}));

import { render } from "../../../test/render";
import { publishThreadChatBridge, type ThreadChatBridge } from "../../layout/threadSurfaceBridge";
import { useRightPanelStore } from "../../rightPanelStore";
import { useFilePendingStore } from "../files/filePendingStore";
import { ThreadSurfaceContent } from "./ThreadSurfaceContent";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

function bridge(patch: Partial<ThreadChatBridge> = {}): ThreadChatBridge {
  return {
    workspaceMutationId: "mutation-7",
    sendReady: true,
    sendAnnotation: () => {},
    addTerminalContext: () => {},
    terminalLaunchContext: null,
    composerDraftTarget: "draft-queued" as never,
    getShortcutContext: () => ({}) as never,
    sideChatParentPanel: { openToolDiff: () => {}, runShellCommand: () => {} },
    linkedPullRequest: null,
    ...patch,
  };
}

function freshStores() {
  const reset = () => {
    captured.props = null;
    useRightPanelStore.setState({ byThreadKey: {} });
    useFilePendingStore.setState({ byProjectKey: new Map() });
  };
  reset();
  return { [Symbol.dispose]: reset };
}

describe("ThreadSurfaceContent", () => {
  it("renders nothing for a surface the thread does not have", async () => {
    using _stores = freshStores();
    await using screen = await render(
      <ThreadSurfaceContent threadRef={threadRef} surfaceId="diff" visible />,
    );
    expect(screen.container.querySelector("[data-testid=surface]")).toBeNull();
    expect(captured.props).toBeNull();
  });

  it("renders the addressed surface of the thread without any chat mounted", async () => {
    using _stores = freshStores();
    useRightPanelStore.getState().open(threadRef, "diff");
    const surfaceId =
      useRightPanelStore.getState().byThreadKey[`${threadRef.environmentId}:${threadRef.threadId}`]
        ?.surfaces[0]?.id;
    expect(surfaceId).toBeDefined();

    await using screen = await render(
      <ThreadSurfaceContent threadRef={threadRef} surfaceId={surfaceId!} visible={false} />,
    );

    expect(
      screen.container.querySelector("[data-testid=surface]")?.getAttribute("data-surface-id"),
    ).toBe(surfaceId);
    expect(captured.props).toMatchObject({
      visible: false,
      workspaceMutationId: null,
      composerDraftTarget: threadRef,
    });
  });

  it("takes the composer target and workspace revision from the thread's mounted chat", async () => {
    using _stores = freshStores();
    useRightPanelStore.getState().open(threadRef, "diff");
    const surfaceId =
      useRightPanelStore.getState().byThreadKey[`${threadRef.environmentId}:${threadRef.threadId}`]
        ?.surfaces[0]?.id;
    const unpublish = publishThreadChatBridge(threadRef, bridge());

    await using _screen = await render(
      <ThreadSurfaceContent threadRef={threadRef} surfaceId={surfaceId!} visible />,
    );

    expect(captured.props).toMatchObject({
      workspaceMutationId: "mutation-7",
      composerDraftTarget: "draft-queued",
    });
    unpublish();
  });
});
