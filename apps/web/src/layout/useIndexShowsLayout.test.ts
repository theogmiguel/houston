import { describe, expect, it } from "vite-plus/test";

import { indexShowsLayout, type IndexLayoutInputs } from "./useIndexShowsLayout";

const base: IndexLayoutInputs = {
  hostedStatic: false,
  environmentsReady: true,
  environmentCount: 1,
  hasProjects: true,
  bootstrapped: true,
};

describe("indexShowsLayout", () => {
  it("shows the layout once a project exists", () => {
    expect(indexShowsLayout(base)).toBe(true);
  });

  it("shows the layout while the shells are still loading, so the index does not flash onboarding", () => {
    expect(indexShowsLayout({ ...base, hasProjects: false, bootstrapped: false })).toBe(true);
  });

  it("leaves onboarding to the index route when every shell loaded and no project exists", () => {
    expect(indexShowsLayout({ ...base, hasProjects: false })).toBe(false);
  });

  it.each([
    { environmentsReady: false, environmentCount: 0 },
    { environmentsReady: true, environmentCount: 0 },
    { environmentsReady: false, environmentCount: 1 },
  ])("keeps a hosted static page on onboarding until an environment exists: %o", (partial) => {
    expect(indexShowsLayout({ ...base, hostedStatic: true, ...partial })).toBe(false);
  });

  it("shows the layout on a hosted static page with a ready environment", () => {
    expect(indexShowsLayout({ ...base, hostedStatic: true })).toBe(true);
  });
});
