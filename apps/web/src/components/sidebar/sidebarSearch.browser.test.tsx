import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { render } from "../../../test/render";
import { SidebarShelves } from "./SidebarShelves";
import {
  SidebarContentResults,
  SidebarNoSearchResults,
  SidebarSearchHighlightContext,
} from "./sidebarSearchResults";

const shelfThread = (id: string, title: string) => ({ id, title }) as EnvironmentThreadShell;

describe("message search results", () => {
  it("lists each thread with its snippet, marks the highlighted one and opens on click", async () => {
    const onOpen = vi.fn();
    await using screen = await render(
      <SidebarSearchHighlightContext.Provider value="b">
        <SidebarContentResults
          results={[
            {
              key: "a",
              thread: shelfThread("a", "Alpha"),
              snippet: "…fixed the sidebar…",
              onOpen: () => {},
            },
            { key: "b", thread: shelfThread("b", "Beta"), snippet: "…sidebar rail…", onOpen },
          ]}
        />
      </SidebarSearchHighlightContext.Provider>,
      { router: false },
    );

    const rows = [
      ...screen.container.querySelectorAll<HTMLElement>(
        "[data-testid='sidebar-content-results'] button",
      ),
    ];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Alpha…fixed the sidebar…",
      "Beta…sidebar rail…",
    ]);
    expect(rows.map((row) => row.hasAttribute("data-search-highlighted"))).toEqual([false, true]);
    await userEvent.click(rows[1]!);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("renders nothing without results", async () => {
    await using screen = await render(<SidebarContentResults results={[]} />, { router: false });
    expect(screen.container.querySelector("[data-testid='sidebar-content-results']")).toBeNull();
  });
});

describe("empty search", () => {
  it("names the query it found nothing for", async () => {
    await using screen = await render(<SidebarNoSearchResults query="zzz" />, { router: false });
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("No threads found for “zzz”");
  });
});

describe("shelves while searching", () => {
  const rows = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-testid='shelf-card']")].map((row) => row.textContent);

  it("lists every matching row on both collapsed shelves, past the Closed page size", async () => {
    localStorage.clear();
    const closed = Array.from({ length: 30 }, (_, index) =>
      shelfThread(`c${index}`, `Closed ${index}`),
    );
    await using screen = await render(
      <SidebarShelves
        held={[shelfThread("h", "Held one")]}
        closed={closed}
        forceExpanded
        renderCard={(thread) => <span data-testid="shelf-card">{thread.title}</span>}
      />,
      { router: false },
    );
    expect(rows(screen.container)).toHaveLength(31);
    expect(screen.container.textContent).not.toContain("Show");
  });

  it("keeps the shelves collapsed when no search is running", async () => {
    localStorage.clear();
    await using screen = await render(
      <SidebarShelves
        held={[shelfThread("h", "Held one")]}
        closed={[shelfThread("c", "Closed one")]}
        renderCard={(thread) => <span data-testid="shelf-card">{thread.title}</span>}
      />,
      { router: false },
    );
    expect(rows(screen.container)).toEqual([]);
  });
});
