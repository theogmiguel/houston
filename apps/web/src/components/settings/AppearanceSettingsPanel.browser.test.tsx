import { RegistryContext } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { render } from "../../../test/render";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { validateSettingsScopeSearch } from "./settingsScope";

async function mountAppearance() {
  const route = createRootRoute({
    validateSearch: validateSettingsScopeSearch,
    component: () => (
      <SettingsScopeProvider search={route.useSearch()} onChange={() => {}}>
        <AppearanceSettingsPanel />
      </SettingsScopeProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/settings/appearance"] }),
  });
  await router.load();
  // The route above validates the settings scope search params, which the default router lacks.
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false },
  );
}

describe("AppearanceSettingsPanel", () => {
  it("starts every section label, the Color scheme label included, at the same left edge", async () => {
    await page.viewport(1440, 900);
    await using screen = await mountAppearance();

    const heading = (name: string) => {
      const match = [...screen.container.querySelectorAll<HTMLElement>("h2, h3")].find(
        (candidate) => candidate.textContent?.trim() === name,
      );
      if (!match) throw new Error(`Missing section label ${JSON.stringify(name)}`);
      return match;
    };

    // The text's own edge, so padding on a label counts.
    const textLeft = (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().left;
    };
    const labels = ["Color scheme", "Theme", "Typography", "Chat"];
    const edges = labels.map((name) => textLeft(heading(name)));
    expect(edges, `left edges of ${labels.join(", ")}`).toEqual(edges.map(() => edges[0]));
  });
});
