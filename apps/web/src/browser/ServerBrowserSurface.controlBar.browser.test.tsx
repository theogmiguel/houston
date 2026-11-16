import { EnvironmentId } from "@houston-app/contracts";
import type { PreviewStreamEvents } from "@houston-app/client-runtime/preview/server-browser-stream";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";

vi.mock(import("@houston-app/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewStreamClient: ((_target: unknown, _handlers: PreviewStreamEvents) => ({
    send: () => undefined,
    stop: () => undefined,
  })) as never,
  createPreviewFramePainter: () => ({ paint: () => undefined, stop: () => undefined }),
}));

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => ({ url: "ws://preview.test", token: "test" }) as never,
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

describe("ServerBrowserSurface control bar", () => {
  it("is hidden while no page is loaded behind the surface and shown otherwise", async () => {
    const barDisplay = async (showControlBar: boolean) => {
      await using screen = await render(
        <ServerBrowserSurface
          environmentId={EnvironmentId.make("environment-copy")}
          threadId="thread-copy"
          tabId="tab-bare"
          visible
          followSize={false}
          showControlBar={showControlBar}
        />,
      );
      const status = screen.container.querySelector<HTMLElement>('[role="status"]')!;
      return getComputedStyle(status.parentElement!).display;
    };

    expect(await barDisplay(false)).toBe("none");
    expect(await barDisplay(true)).toBe("flex");
  });
});
