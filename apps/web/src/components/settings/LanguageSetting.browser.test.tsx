import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import { GeneralSettingsPanel } from "./SettingsPanels";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { validateSettingsScopeSearch } from "./settingsScope";

async function mountGeneral() {
  const route = createRootRoute({
    validateSearch: validateSettingsScopeSearch,
    component: () => (
      <SettingsScopeProvider search={route.useSearch()} onChange={() => {}}>
        <GeneralSettingsPanel />
      </SettingsScopeProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
  });
  await router.load();
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false },
  );
}

function headings(container: HTMLElement): string[] {
  return [...container.querySelectorAll("h2, h3")].map((node) => node.textContent?.trim() ?? "");
}

/** Starts a test from saved settings and restores the defaults when the test ends. */
function savedSettings(language: string): Disposable {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, language });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS) };
}

describe("Language setting", () => {
  it("shows English with the current value by default", async () => {
    using _settings = savedSettings("en");
    await page.viewport(1440, 900);
    await using screen = await mountGeneral();

    expect(headings(screen.container)).toContain("Language");
    await expect
      .element(page.getByRole("combobox", { name: "Language" }))
      .toHaveTextContent("English");
  });

  it("re-renders translated labels as soon as Português (Brasil) is chosen", async () => {
    using _settings = savedSettings("en");
    await page.viewport(1440, 900);
    await using screen = await mountGeneral();
    expect(headings(screen.container)).toContain("Display");

    await page.getByRole("combobox", { name: "Language" }).click();
    await page.getByRole("option", { name: "Português (Brasil)" }).click();

    await expect.poll(() => headings(screen.container)).toContain("Exibição");
    expect(headings(screen.container)).not.toContain("Display");
    expect(getClientSettings().language).toBe("pt-BR");
    await expect
      .element(page.getByRole("combobox", { name: "Idioma" }))
      .toHaveTextContent("Português (Brasil)");
  });

  it("renders English text for a saved language it has no catalogue for", async () => {
    using _settings = savedSettings("klingon");
    await page.viewport(1440, 900);
    await using screen = await mountGeneral();

    expect(headings(screen.container)).toContain("Display");
  });
});

describe("Language setting on the Settings navigation", () => {
  it("translates section labels and the breadcrumb, and searches by the translated title", async () => {
    using _settings = savedSettings("pt-BR");
    await page.viewport(1440, 900);
    await using screen = await render(
      <SidebarProvider>
        <SettingsSidebarNav pathname="/settings/general" />
        <SettingsBreadcrumb pathname="/settings/general" />
      </SidebarProvider>,
      { router: "/settings/general" },
    );

    const text = () => screen.container.textContent ?? "";
    expect(text()).toContain("Aparência");
    expect(text()).toContain("Configurações");
    expect(text()).not.toContain("Appearance");

    await page.getByRole("combobox", { name: "Buscar configurações" }).fill("idioma");
    await expect.element(page.getByRole("option", { name: /^Idioma\s*Geral/ })).toBeVisible();
  });
});
