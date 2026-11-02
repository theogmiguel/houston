import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { releasePublishedAtom } from "./releasePublication";

const version = "0.0.46-nightly.20261012.3021";

const releaseBody = {
  tag_name: `v${version}`,
  draft: false,
  assets: [
    { name: `houston-${version}-linux-x64.tar.gz` },
    { name: `houston-${version}-linux-arm64.tar.gz` },
    { name: "SHA256SUMS" },
  ],
};

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settledCheck() {
  const atom = releasePublishedAtom(version);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("releasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("checks the GitHub release without tracing headers, so the browser skips the preflight GitHub rejects", async () => {
    fetchMock.mockImplementation(async () => Response.json(releaseBody));

    const result = await settledCheck();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(
      `https://api.github.com/repos/theogmiguel/houston/releases/tags/v${version}`,
    );
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(AsyncResult.getOrElse(result, () => false)).toBe(true);
  });

  it("treats a draft or an archive-less release as unpublished", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ ...releaseBody, draft: true, assets: [] }),
    );

    const result = await settledCheck();

    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });

  // regression: #18709 update-everything skipped release-installed servers
  it("leaves a failed first check unknown, which callers read as unpublished", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settledCheck();

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });
});
