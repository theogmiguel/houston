import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopLocale, translateDesktop } from "./translate.ts";

describe("desktop catalogue", () => {
  it("falls back to English for an unknown language", () => {
    expect(resolveDesktopLocale("fr")).toBe("en");
    expect(translateDesktop("en", "Settings...")).toBe("Settings...");
  });

  it("renders the native menu labels in Brazilian Portuguese", () => {
    expect(translateDesktop("pt-BR", "Settings...")).toBe("Configurações...");
    expect(translateDesktop("pt-BR", "Quit {app}", { app: "Houston" })).toBe("Sair do Houston");
    expect(translateDesktop("pt-BR", "Agents ({count})", { count: 3 })).toBe("Agentes (3)");
  });

  it("keeps a placeholder without a value untouched", () => {
    expect(translateDesktop("pt-BR", "Hide {app}")).toBe("Ocultar {app}");
  });
});
