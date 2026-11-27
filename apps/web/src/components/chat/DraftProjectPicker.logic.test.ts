import { describe, expect, it } from "vite-plus/test";

import {
  ADD_PROJECT_VALUE,
  NO_PROJECT_VALUE,
  buildDraftProjectPickerItems,
  filterDraftProjectPickerItems,
  type DraftProjectPickerItem,
} from "./DraftProjectPicker.logic";

const projects = [
  { value: "local:p1", label: "Atlas" },
  { value: "local:p2", label: "Borealis" },
];

function matches(item: DraftProjectPickerItem, query: string): boolean {
  return item.searchTerms.some((term) => term.toLowerCase().includes(query.toLowerCase()));
}

function labels(items: ReadonlyArray<DraftProjectPickerItem>): string[] {
  return items.map((item) => item.label);
}

describe("buildDraftProjectPickerItems", () => {
  it("puts No project after the projects and before Add project", () => {
    const items = buildDraftProjectPickerItems({ projects, showNoProject: true });

    expect(items.map((item) => item.value)).toEqual([
      "local:p1",
      "local:p2",
      NO_PROJECT_VALUE,
      ADD_PROJECT_VALUE,
    ]);
    expect(labels(items)).toEqual(["Atlas", "Borealis", "No project", "Add project"]);
  });

  it("leaves out No project when the environment has no scratch root", () => {
    const items = buildDraftProjectPickerItems({ projects, showNoProject: false });

    expect(items.map((item) => item.value)).toEqual(["local:p1", "local:p2", ADD_PROJECT_VALUE]);
  });
});

describe("filterDraftProjectPickerItems", () => {
  const items = buildDraftProjectPickerItems({ projects, showNoProject: true });

  it("keeps every row for an empty query", () => {
    expect(filterDraftProjectPickerItems(items, "  ", matches)).toEqual(items);
  });

  it("matches No project by its search terms and still hides Add project", () => {
    for (const query of ["no project", "without", "none"]) {
      expect(labels(filterDraftProjectPickerItems(items, query, matches))).toEqual(["No project"]);
    }
  });

  it("filters project rows by their names and hides Add project while searching", () => {
    expect(labels(filterDraftProjectPickerItems(items, "bore", matches))).toEqual(["Borealis"]);
    expect(labels(filterDraftProjectPickerItems(items, "add", matches))).toEqual([]);
  });
});
