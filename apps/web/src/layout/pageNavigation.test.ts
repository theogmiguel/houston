import { describe, expect, it } from "vite-plus/test";

import { layoutRoutePage } from "./pageNavigation";

describe("layoutRoutePage", () => {
  it("shows every pull requests URL as the layout's page tab", () => {
    for (const href of ["/pull-requests?state=open", "/pull-requests?pane=1&state=open"]) {
      expect(layoutRoutePage({ pathname: "/pull-requests", href })).toEqual({
        kind: "pull-requests",
        href,
      });
    }
  });

  it("shows every tasks URL as the layout's page tab, keeping its search", () => {
    for (const href of ["/tasks", "/tasks?view=sources&q=a", "/tasks?task=T-1"]) {
      expect(layoutRoutePage({ pathname: "/tasks", href })).toEqual({ kind: "tasks", href });
    }
  });

  it("leaves Settings and Usage to their modals", () => {
    for (const pathname of ["/settings/general", "/settings/usage", "/usage"]) {
      expect(layoutRoutePage({ pathname, href: pathname })).toBeNull();
    }
  });
});
