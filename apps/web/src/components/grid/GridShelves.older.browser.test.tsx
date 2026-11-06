import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { GridShelves } from "./GridShelves";

const shelf = vi.hoisted(() => ({
  loading: false,
  failed: false,
  unloaded: 0,
  unlisted: new Set<string>(),
  retry: vi.fn(),
  growthListed: [] as string[],
}));

vi.mock(import("../../state/olderSettledShelf"), async (original) => ({
  ...(await original()),
  useOlderSettledShelf: (() => ({
    isListed: (thread: { id: string }) => !shelf.unlisted.has(thread.id),
    unloadedCount: () => shelf.unloaded,
    loading: shelf.loading,
    failed: shelf.failed,
    retry: shelf.retry,
  })) as never,
  useOlderSettledShelfGrowth: ((_: unknown, listed: ReadonlyArray<{ id: string }>) => {
    shelf.growthListed = listed.map((thread) => thread.id);
  }) as never,
}));

const closedThread = (id: string) => ({ id, title: id }) as EnvironmentThreadShell;
const closed = Array.from({ length: 12 }, (_, index) => closedThread(`c${index}`));

function reset() {
  localStorage.clear();
  shelf.loading = false;
  shelf.failed = false;
  shelf.unloaded = 0;
  shelf.unlisted = new Set();
  shelf.retry.mockClear();
}

async function open(rows = closed) {
  const screen = await render(
    <GridShelves
      held={[]}
      closed={rows}
      renderCard={(thread) => <span data-testid="shelf-card">{thread.title}</span>}
      older={{ scopes: [], threads: [] }}
    />,
    { router: false },
  );
  await userEvent.click(
    screen.container.querySelector<HTMLElement>('[data-testid="grid-settled-shelf-toggle"]')!,
  );
  return screen;
}

describe("Closed shelf with older threads on the server", () => {
  it("counts the threads not loaded yet and offers to show them", async () => {
    reset();
    shelf.unloaded = 40;
    await using screen = await open();
    await expect
      .element(screen.getByRole("treeitem", { name: /Closed/ }))
      .toHaveTextContent("Closed52");
    await expect.element(screen.getByRole("button", { name: "Show 25 more" })).toBeInTheDocument();
  });

  it("shows Loading, disabled, while a page is read", async () => {
    reset();
    shelf.unloaded = 40;
    shelf.loading = true;
    await using screen = await open();
    await expect.element(screen.getByRole("button", { name: "Loading" })).toBeDisabled();
  });

  it("names the failure and retries the read on click", async () => {
    reset();
    shelf.unloaded = 40;
    shelf.failed = true;
    await using screen = await open();
    await userEvent.click(
      screen.getByRole("button", { name: "Could not load older threads. Retry" }),
    );
    expect(shelf.retry).toHaveBeenCalledOnce();
  });

  it("lists only the rows at or above the frontier and grows from them", async () => {
    reset();
    shelf.unlisted = new Set(["c0", "c1"]);
    await using screen = await open();
    expect(shelf.growthListed).toHaveLength(10);
    expect(screen.container.textContent).not.toContain("c0c1");
    const shown = [...screen.container.querySelectorAll("[data-testid='shelf-card']")].map(
      (row) => row.textContent,
    );
    expect(shown).not.toContain("c0");
    expect(shown).not.toContain("c1");
  });

  it("offers no paging button when everything is listed", async () => {
    reset();
    await using screen = await open(closed.slice(0, 3));
    expect(screen.container.textContent).not.toContain("Show");
  });
});
