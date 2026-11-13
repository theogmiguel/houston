import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const seen = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));

vi.mock("../ChatView", () => ({
  default: (props: Record<string, unknown>) => {
    seen.props = props;
    return <div data-testid="chat" />;
  },
}));

import { render } from "../../../test/render";
import { LayoutPaneContext, LONE_PANE } from "../../layout/layoutPaneContext";
import { ThreadChatSurface } from "./ThreadChatSurface";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

describe("ThreadChatSurface", () => {
  it("opens the chat of the thread reference as an embedded server chat", async () => {
    await using _screen = await render(<ThreadChatSurface threadRef={threadRef} />);
    expect(seen.props).toMatchObject({
      routeKind: "server",
      embedded: true,
      environmentId: "env-1",
      threadId: "thread-1",
      shortcutsAtWindow: true,
      visitActive: true,
    });
  });

  it("opens a draft chat when given the thread's draft", async () => {
    await using _screen = await render(
      <ThreadChatSurface threadRef={threadRef} draftId={"draft-1" as never} />,
    );
    expect(seen.props).toMatchObject({ routeKind: "draft", draftId: "draft-1" });
  });

  it("answers window shortcuts and counts visits only while its pane is focused and visible", async () => {
    const pane = (focused: boolean, visible: boolean) => ({ ...LONE_PANE, focused, visible });
    await using _unfocused = await render(
      <LayoutPaneContext value={pane(false, true)}>
        <ThreadChatSurface threadRef={threadRef} />
      </LayoutPaneContext>,
    );
    expect(seen.props).toMatchObject({ shortcutsAtWindow: false, visitActive: false });

    await using _hidden = await render(
      <LayoutPaneContext value={pane(true, false)}>
        <ThreadChatSurface threadRef={threadRef} />
      </LayoutPaneContext>,
    );
    expect(seen.props).toMatchObject({ shortcutsAtWindow: true, visitActive: false });
  });

  it("passes the host's pane options through", async () => {
    await using _screen = await render(
      <ThreadChatSurface
        threadRef={threadRef}
        paneDensity="glance"
        hostTerminalRef={threadRef}
        phoneShell
        detailsOpen
      />,
    );
    expect(seen.props).toMatchObject({
      paneDensity: "glance",
      hostTerminalRef: threadRef,
      phoneShell: true,
      detailsOpen: true,
    });
  });
});
