import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { buildLayout } from "./layoutFixtures";
import { LayoutHost } from "./LayoutHost";
import { useLayoutStore } from "./layoutStore";

/** How many times each thread's chat mounted, so a test can tell a kept chat from a rebuilt one. */
const chatMounts = vi.hoisted(() => new Map<string, number>());

vi.mock(import("../components/chat/ThreadChatSurface"), () => ({
  ThreadChatSurface: function MockChat({ threadRef }: { threadRef: { threadId: string } }) {
    const [countMount] = useState(() => (element: HTMLElement | null) => {
      if (element)
        chatMounts.set(threadRef.threadId, (chatMounts.get(threadRef.threadId) ?? 0) + 1);
    });
    return (
      <div ref={countMount} data-testid={`chat-${threadRef.threadId}`}>
        chat {threadRef.threadId}
      </div>
    );
  },
}));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: () => ({ deletedAt: null }) as never,
}));

vi.mock(import("../state/shell"), async (original) => ({
  ...(await original()),
  useEnvironmentShellStatus: () => "ready" as never,
}));

function openLayout(shape: string[][][][]): Disposable {
  useLayoutStore.getState().reset();
  chatMounts.clear();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  return { [Symbol.dispose]: () => useLayoutStore.getState().reset() };
}

function Sized({ children }: { children: React.ReactNode }) {
  return <div style={{ width: 1000, height: 600, position: "relative" }}>{children}</div>;
}

const host = (
  <Sized>
    <LayoutHost threadTarget={null} atIndex active narrow={false} />
  </Sized>
);

describe("LayoutHost", () => {
  it("shows nothing before the first layout snapshot", async () => {
    useLayoutStore.getState().reset();
    await using screen = await render(host);
    expect(screen.container.querySelector("[data-layout-strip]")).toBeNull();
  });

  it("shows a chat tab with its thread's chat", async () => {
    using _layout = openLayout([[[["t1"]]]]);
    await using _screen = await render(host);
    await expect.element(page.getByTestId("chat-t1")).toBeVisible();
  });

  it("shows two columns side by side", async () => {
    using _layout = openLayout([[[["t1"]], [["t2"]]]]);
    await using _screen = await render(host);
    await expect.element(page.getByTestId("chat-t2")).toBeVisible();
    const left = page.getByTestId("chat-t1").element().getBoundingClientRect();
    const right = page.getByTestId("chat-t2").element().getBoundingClientRect();
    expect(left.right).toBeLessThanOrEqual(right.left);
  });

  it("stacks two panes of one column", async () => {
    using _layout = openLayout([[[["t1"], ["t2"]]]]);
    await using _screen = await render(host);
    await expect.element(page.getByTestId("chat-t2")).toBeVisible();
    const rectOf = (id: string) => page.getByTestId(id).element().getBoundingClientRect();
    await expect.poll(() => rectOf("chat-t1").bottom <= rectOf("chat-t2").top).toBe(true);
  });

  it("shows only the focused pane in a narrow window", async () => {
    using _layout = openLayout([[[["t1"]], [["t2"]]]]);
    await using _screen = await render(
      <Sized>
        <LayoutHost threadTarget={null} atIndex active narrow />
      </Sized>,
    );
    await expect.element(page.getByTestId("chat-t1")).toBeVisible();
    expect(page.getByTestId("chat-t2").query()).toBeNull();
  });

  it("shows the launcher in an empty workspace", async () => {
    using _layout = openLayout([[]]);
    await using screen = await render(host);
    expect(screen.container.querySelector("[data-new-tab-launcher]")).not.toBeNull();
  });

  it("publishes the threads on screen for the sidebar, and clears them when the layout is covered", async () => {
    using _layout = openLayout([[[["t1"]], [["t2"]]]]);
    await using screen = await render(host);
    const keys = () => [...useLayoutStore.getState().onScreenThreadKeys].toSorted();
    await expect.poll(() => keys().map((key) => key.split(":").at(-1))).toEqual(["t1", "t2"]);
    await screen.rerender(
      <Sized>
        <LayoutHost threadTarget={null} atIndex active={false} narrow={false} />
      </Sized>,
    );
    await expect.poll(keys).toEqual([]);
  });

  it("draws a stand-in, not the chat, for a pane far from the camera, and the chat as it comes near", async () => {
    const layout = buildLayout([[..."abcdefghij"].map((name) => [[name]])]);
    for (const column of layout.workspaces[0]!.columns) column.width = 0.5;
    layout.workspaces[0]!.cameraWidth = 1000;
    useLayoutStore.getState().reset();
    chatMounts.clear();
    useLayoutStore.getState().setLayoutFromServer(layout);
    await using screen = await render(host);
    await expect.element(page.getByTestId("chat-a")).toBeVisible();
    expect(page.getByTestId("chat-j").query()).toBeNull();
    expect(screen.container.querySelectorAll("[data-layout-stand-in]").length).toBeGreaterThan(0);
    const scroller = screen.container.querySelector<HTMLElement>("[data-layout-strip]")!;
    scroller.scrollLeft = 4000;
    await expect.element(page.getByTestId("chat-j")).toBeInTheDocument();
    useLayoutStore.getState().reset();
  });

  it("keeps a chat mounted while its workspace is off screen and shows the same chat on return", async () => {
    using _layout = openLayout([[[["t1"]]], [[["t2"]]]]);
    await using _screen = await render(host);
    await expect.element(page.getByTestId("chat-t1")).toBeVisible();
    useLayoutStore.getState().focusWorkspace("w1");
    await expect.element(page.getByTestId("chat-t2")).toBeVisible();
    expect(page.getByTestId("chat-t1").query()).not.toBeNull();
    useLayoutStore.getState().focusWorkspace("w0");
    await expect.element(page.getByTestId("chat-t1")).toBeVisible();
    expect(chatMounts.get("t1")).toBe(1);
  });

  it("gives a closed pane's space to its neighbour when its last tab closes", async () => {
    using _layout = openLayout([[[["t1"]], [["t2"]]]]);
    await using _screen = await render(host);
    await expect.element(page.getByTestId("chat-t2")).toBeVisible();
    useLayoutStore.getState().closeTab("t1");
    await expect.poll(() => page.getByTestId("chat-t1").query()).toBeNull();
    await expect
      .poll(() => page.getByTestId("chat-t2").element().getBoundingClientRect().width)
      .toBeGreaterThan(900);
    expect(useLayoutStore.getState().layout.workspaces[0]!.columns).toHaveLength(1);
  });

  it("shows the launcher once the last tab of the last pane closes", async () => {
    using _layout = openLayout([[[["t1"]]]]);
    await using screen = await render(host);
    await expect.element(page.getByTestId("chat-t1")).toBeVisible();
    useLayoutStore.getState().closeTab("t1");
    await expect
      .poll(() => screen.container.querySelector("[data-new-tab-launcher]"))
      .not.toBeNull();
    expect(page.getByTestId("chat-t1").query()).toBeNull();
  });

  it("switches to another workspace and shows its panes", async () => {
    using _layout = openLayout([[[["t1"]]], [[["t2"]], [["t3"]]]]);
    await using _screen = await render(host);
    await expect.element(page.getByTestId("chat-t1")).toBeVisible();
    useLayoutStore.getState().focusWorkspace("w1");
    await expect.element(page.getByTestId("chat-t2")).toBeVisible();
    await expect.element(page.getByTestId("chat-t3")).toBeVisible();
    expect(
      page
        .getByTestId("chat-t1")
        .element()
        .closest("[data-layout-pane-body]")
        ?.hasAttribute("inert"),
    ).toBe(true);
  });
});
