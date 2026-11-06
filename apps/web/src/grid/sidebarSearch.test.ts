import { describe, expect, it } from "vite-plus/test";

import {
  clampSearchHighlight,
  contentOnlyMatches,
  moveSearchHighlight,
  orderSearchResults,
} from "./sidebarSearch";

const match = (threadId: string) => ({ environmentId: "env", threadId });
const keyOf = (m: { environmentId: string; threadId: string }) =>
  `${m.environmentId}:${m.threadId}`;

describe("orderSearchResults", () => {
  it("keeps the first place of a key that appears in several groups", () => {
    expect(orderSearchResults(["a", "b"], ["b", "c"], ["a", "d"])).toEqual(["a", "b", "c", "d"]);
  });
});

describe("contentOnlyMatches", () => {
  it("drops threads the rail already shows, hidden ones and repeats, keeping the server's order", () => {
    const result = contentOnlyMatches(
      [match("a"), match("b"), match("b"), match("c"), match("d")],
      {
        keyOf,
        shownKeys: new Set(["env:a"]),
        isVisible: (m) => m.threadId !== "c",
      },
    );
    expect(result.map((m) => m.threadId)).toEqual(["b", "d"]);
  });

  it("stops at the limit", () => {
    const result = contentOnlyMatches([match("a"), match("b"), match("c")], {
      keyOf,
      shownKeys: new Set(),
      isVisible: () => true,
      limit: 2,
    });
    expect(result.map((m) => m.threadId)).toEqual(["a", "b"]);
  });
});

describe("moveSearchHighlight", () => {
  it("wraps in both directions", () => {
    expect(moveSearchHighlight(2, 3, 1)).toBe(0);
    expect(moveSearchHighlight(0, 3, -1)).toBe(2);
    expect(moveSearchHighlight(1, 3, 1)).toBe(2);
  });

  it("stays at 0 without results", () => {
    expect(moveSearchHighlight(0, 0, 1)).toBe(0);
  });
});

describe("clampSearchHighlight", () => {
  it("keeps the index inside a shrunken list", () => {
    expect(clampSearchHighlight(5, 3)).toBe(2);
    expect(clampSearchHighlight(-1, 3)).toBe(0);
    expect(clampSearchHighlight(4, 0)).toBe(0);
  });
});
