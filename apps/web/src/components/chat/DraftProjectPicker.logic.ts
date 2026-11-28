export const ADD_PROJECT_VALUE = "add-project";
export const NO_PROJECT_VALUE = "no-project";

export type DraftProjectPickerItemKind = "project" | "no-project" | "add-project";

export interface DraftProjectPickerItem {
  readonly value: string;
  readonly label: string;
  readonly kind: DraftProjectPickerItemKind;
  readonly searchTerms: readonly string[];
}

export interface DraftProjectPickerProject {
  readonly value: string;
  readonly label: string;
}

export const NO_PROJECT_SEARCH_TERMS = ["no project", "without project", "none"] as const;

export function buildDraftProjectPickerItems(input: {
  readonly projects: ReadonlyArray<DraftProjectPickerProject>;
  readonly showNoProject: boolean;
}): DraftProjectPickerItem[] {
  return [
    ...input.projects.map((project): DraftProjectPickerItem => ({
      value: project.value,
      label: project.label,
      kind: "project",
      searchTerms: [project.label],
    })),
    ...(input.showNoProject
      ? [
          {
            value: NO_PROJECT_VALUE,
            label: "No project",
            kind: "no-project" as const,
            searchTerms: NO_PROJECT_SEARCH_TERMS,
          },
        ]
      : []),
    {
      value: ADD_PROJECT_VALUE,
      label: "Add project",
      kind: "add-project",
      searchTerms: ["Add project"],
    },
  ];
}

/**
 * The action rows follow the palette: "Add project" stays out of search results, while
 * "No project" matches on its own words.
 */
export function filterDraftProjectPickerItems(
  items: ReadonlyArray<DraftProjectPickerItem>,
  query: string,
  matches: (item: DraftProjectPickerItem, query: string) => boolean,
): DraftProjectPickerItem[] {
  const search = query.trim();
  if (search.length === 0) {
    return [...items];
  }
  return items.filter((item) => item.kind !== "add-project" && matches(item, search));
}
