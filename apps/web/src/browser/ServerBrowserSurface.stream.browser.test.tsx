import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

vi.mock("~/state/previewStream", () => ({
  usePreviewStreamAccess: () => ({
    httpBase: "http://localhost:1234/api/preview-stream",
    wsBase: "ws://localhost:1234/api/preview-stream",
    query: {},
    credentials: true,
  }),
  refreshPreviewStreamAccess: () => {},
}));

// Reproduce a surface whose observer never delivers its first measurement (a panel that
// mounts hidden or before layout settles) under StrictMode, which replays effects. The
// client must still connect.
vi.mock("~/lib/observeResize", () => ({ observeResize: () => () => {} }));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

class FakeWebSocket {
  static readonly urls: string[] = [];
  binaryType = "";
  constructor(url: string) {
    FakeWebSocket.urls.push(String(url));
  }
  addEventListener() {}
  send() {}
  close() {}
}

describe("ServerBrowserSurface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects after StrictMode replays the sizing effect without an observer delivery", async () => {
    FakeWebSocket.urls.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    // A laid-out panel measures the same size on both StrictMode passes, so the replay must
    // still grow the cap the first pass scheduled and its cleanup cancelled.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 400, 300),
    );
    await using _screen = await render(
      <StrictMode>
        <ServerBrowserSurface
          environmentId={EnvironmentId.make("env-1")}
          threadId={ThreadId.make("thread-1")}
          tabId="tab-1"
          visible
          className="h-[300px] w-[400px]"
        />
      </StrictMode>,
      { router: false },
    );
    await vi.waitFor(() => expect(FakeWebSocket.urls.length).toBeGreaterThan(0));
    expect(FakeWebSocket.urls[0]).toContain("/api/preview-stream/ws");
  });
});
