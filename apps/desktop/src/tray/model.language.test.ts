import type { DesktopTrayPayload } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { headerText, menuModel } from "./model.ts";

function payload(language: string): DesktopTrayPayload {
  return {
    connection: "ready",
    language,
    sessions: [
      {
        id: "env:thread",
        agent: "claude",
        title: "Fix the rail",
        status: "running",
        needsInput: false,
        workspace: "Houston",
      },
    ],
  };
}

describe("native tray menu language", () => {
  it("labels the tray in English when the language is English", () => {
    expect(headerText(payload("en"))).toBe("Houston · 1 agent running");
    expect(menuModel(payload("en")).find((item) => item.type === "submenu")).toEqual({
      type: "submenu",
      label: "Agents (1)",
      items: expect.any(Array),
    });
  });

  it("labels the tray in Brazilian Portuguese", () => {
    expect(headerText(payload("pt-BR"))).toBe("Houston · 1 agente em execução");
    expect(menuModel(payload("pt-BR")).find((item) => item.type === "submenu")).toEqual({
      type: "submenu",
      label: "Agentes (1)",
      items: expect.any(Array),
    });
  });
});
