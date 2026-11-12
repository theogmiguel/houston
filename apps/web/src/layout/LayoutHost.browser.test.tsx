import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { buildLayout } from "./layoutFixtures";
import { LayoutHost } from "./LayoutHost";
import { useLayoutStore } from "./layoutStore";

vi.mock(import("../components/chat/ThreadChatSurface"), () => ({
  ThreadChatSurface: ({ threadRef }: { threadRef: { threadId: string } }) => (
    <div data-testid={`chat-${threadRef.threadId}`}>chat {threadRef.threadId}</div>
  ),
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
});
