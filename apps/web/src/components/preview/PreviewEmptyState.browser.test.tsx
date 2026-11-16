import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({ servers: [] as PreviewableServer[] }));

vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./PreviewFaviconIcon"), async (original) => ({
  ...(await original()),
  PreviewFaviconIcon: (() => <span />) as never,
}));

import { PreviewEmptyState } from "./PreviewEmptyState";

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;

const SERVER = {
  host: "127.0.0.1",
  port: 5173,
  processName: "vite",
  source: "scanner",
  requestedUrl: "http://127.0.0.1:5173/",
} as unknown as PreviewableServer;

async function renderEmptyState() {
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 500px; position: relative;";
  return render(
    <PreviewEmptyState
      threadRef={THREAD_REF}
      environmentId={THREAD_REF.environmentId}
      recentEntries={[]}
      onRemoveRecent={() => undefined}
      onOpenUrl={() => undefined}
    />,
    { container },
  );
}

describe("PreviewEmptyState with local servers", () => {
  it("opens with a heading and one line of help, set clear of the panel's top edge", async () => {
    mocks.servers = [SERVER];
    await using screen = await renderEmptyState();
    const heading = [...screen.container.querySelectorAll<HTMLElement>("h2")].find(
      (element) => element.textContent === "Open a page",
    )!;
    expect(heading).toBeDefined();
    const help = heading.nextElementSibling as HTMLElement;
    expect(help.tagName).toBe("P");
    expect(help.textContent).toMatch(/type a URL above/);
    const top = heading.getBoundingClientRect().top - screen.container.getBoundingClientRect().top;
    expect(top).toBeGreaterThanOrEqual(40);
    // The heading leads the list: the first server row sits below the help line.
    const row = screen.container.querySelector<HTMLElement>("button")!;
    expect(row.getBoundingClientRect().top).toBeGreaterThan(help.getBoundingClientRect().bottom);
  });
});

describe("PreviewEmptyState server rows", () => {
  it("marks each detected local server with a live dot", async () => {
    mocks.servers = [SERVER];
    await using screen = await renderEmptyState();
    const dot = screen.container.querySelector('[data-slot="live-dot"]');
    expect(dot?.getAttribute("aria-label")).toBe("Live");
  });
});
