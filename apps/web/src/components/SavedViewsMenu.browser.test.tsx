import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";
import type { IssueListPreferences } from "./issue/issueListPreferences";
import { ISSUE_SAVED_VIEWS } from "./issue/issueSavedViews";
import { SavedViewsMenu, type SavedView } from "./SavedViewsMenu";

const ISSUE_SAVED_VIEWS_KEY = ISSUE_SAVED_VIEWS.storageKey;

const { toastAdd } = vi.hoisted(() => ({ toastAdd: vi.fn() }));
vi.mock("./ui/toast", () => ({ toastManager: { add: toastAdd } }));

const assigned = {
  who: "assigned",
  status: "open",
  host: "github.com",
  q: "crash",
  label: ["bug", "priority"],
  assignee: "octocat",
  order: "created",
} as const satisfies IssueListPreferences;

function setup() {
  localStorage.clear();
  const onApply = vi.fn();
  toastAdd.mockClear();
  return {
    onApply,
    menu: (preferences: IssueListPreferences = assigned) => (
      <SavedViewsMenu kind={ISSUE_SAVED_VIEWS} preferences={preferences} onApply={onApply} />
    ),
    [Symbol.dispose]() {
      localStorage.clear();
      vi.restoreAllMocks();
    },
  };
}

async function openMenu(screen: Screen) {
  await act(() =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Saved issue views"]')!.click(),
  );
}

async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === label,
  );
  expect(item, label).toBeDefined();
  await act(() => item!.click());
}

async function nameView(name: string) {
  const input = document.querySelector<HTMLInputElement>("input")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(() =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

function storedViews(): ReadonlyArray<SavedView<IssueListPreferences>> {
  return JSON.parse(localStorage.getItem(ISSUE_SAVED_VIEWS_KEY) ?? "[]");
}

describe("SavedViewsMenu", () => {
  it("saves a named filter setup and restores it after remounting", async () => {
    using fixture = setup();
    const { menu } = fixture;
    await using first = await render(menu());
    await openMenu(first);
    await choose("Save current view…");
    expect(document.querySelector("input")?.value).toBe("Issues Assigned to Me");
    await submit();
    expect(storedViews()).toEqual([
      { id: expect.any(String), name: "Issues Assigned to Me", preferences: assigned },
    ]);

    await first.unmount();
    const merged = { who: "all", status: "closed", host: "gitlab.com" } as const;
    await using screen = await render(menu(merged));
    await openMenu(screen);
    await choose("Issues Assigned to Me");
    expect(fixture.onApply).toHaveBeenCalledExactlyOnceWith(assigned);
  });

  it("updates, renames, and deletes a view without affecting another saved view", async () => {
    using fixture = setup();
    const { menu } = fixture;
    localStorage.setItem(
      ISSUE_SAVED_VIEWS_KEY,
      JSON.stringify([
        { id: "assigned", name: "Mine", preferences: assigned },
        { id: "authored", name: "My issues", preferences: { who: "authored", status: "open" } },
      ]),
    );
    await using screen = await render(menu());
    await openMenu(screen);
    await choose("Mine");
    await screen.rerender(menu({ ...assigned, q: "focus" }));
    await openMenu(screen);
    await choose("Update saved view");
    expect(storedViews()[0]?.preferences.q).toBe("focus");
    await openMenu(screen);
    await choose("Rename view…");
    await nameView("My issues");
    expect(document.body.textContent).toContain("A view with this name already exists.");
    await nameView("  Triage  ");
    await submit();
    expect(storedViews()[0]?.name).toBe("Triage");
    await openMenu(screen);
    await choose("Delete view");
    expect(storedViews().map((view) => view.id)).toEqual(["authored"]);
  });

  it("keeps an inferred view as the update target when edits match another view", async () => {
    using fixture = setup();
    const { menu } = fixture;
    const other = {
      id: "other",
      name: "Other queue",
      preferences: { ...assigned, q: "focus" },
    } as const;
    localStorage.setItem(
      ISSUE_SAVED_VIEWS_KEY,
      JSON.stringify([{ id: "assigned", name: "Mine", preferences: assigned }, other]),
    );
    await using screen = await render(menu());
    await screen.rerender(menu(other.preferences));
    expect(screen.container.textContent).toContain("Mine*");
    await openMenu(screen);
    await choose("Update saved view");
    expect(storedViews()).toEqual([
      { id: "assigned", name: "Mine", preferences: other.preferences },
      other,
    ]);
    await openMenu(screen);
    await choose("Other queue");
    expect(screen.container.textContent).toContain("Other queue");
  });
});
