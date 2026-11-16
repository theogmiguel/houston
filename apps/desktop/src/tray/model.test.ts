import { describe, expect, it } from "@effect/vitest";

import type {
  DesktopTrayPayload,
  DesktopTraySession,
  DesktopTrayStatus,
} from "@houston-app/contracts";

import {
  ATTENTION_ROW_CAP,
  GROUP_ROW_CAP,
  agentLabel,
  baseIconSize,
  headerText,
  iconSizeFor,
  iconState,
  menuModel,
  sessionLabel,
  statusGlyph,
  trayIconFile,
  type TrayItem,
} from "./model.ts";

function threadKey(n: number): string {
  return `primary:${n}`;
}

function sessionIn(
  id: number,
  agent: string,
  title: string,
  status: DesktopTrayStatus,
  workspace = "houston",
): DesktopTraySession {
  return {
    id: threadKey(id),
    agent,
    title,
    status,
    needsInput: status === "needsInput",
    workspace,
  };
}

function session(
  id: number,
  agent: string,
  title: string,
  status: DesktopTrayStatus,
): DesktopTraySession {
  return sessionIn(id, agent, title, status);
}

function ready(sessions: readonly DesktopTraySession[]): DesktopTrayPayload {
  return { connection: "ready", sessions };
}

function submenu(items: readonly TrayItem[]): readonly TrayItem[] {
  const found = items.find((item) => item.type === "submenu");
  if (found?.type !== "submenu") throw new Error("menu has no Agents submenu");
  return found.items;
}

describe("tray model", () => {
  it("names running and waiting counts in the header", () => {
    const payload = ready([
      session(1, "claude", "refactor auth", "running"),
      session(2, "codex", "port the wire", "running"),
      session(3, "claude", "grid teardown", "running"),
      session(4, "claude", "release notes", "needsInput"),
    ]);
    expect(headerText(payload)).toBe("Houston · 3 agents running · 1 needs input");
  });

  it("uses the singular agent and the plural verb", () => {
    expect(headerText(ready([session(1, "claude", "a", "running")]))).toBe(
      "Houston · 1 agent running",
    );
    expect(
      headerText(
        ready([session(1, "claude", "a", "needsInput"), session(2, "codex", "b", "needsInput")]),
      ),
    ).toBe("Houston · 2 need input");
  });

  it("says idle with no sessions and names the count with only quiet ones", () => {
    expect(headerText(ready([]))).toBe("Houston · idle");
    expect(
      headerText(ready([session(1, "claude", "a", "idle"), session(2, "shell", "b", "idle")])),
    ).toBe("Houston · 2 agents idle");
    expect(headerText(ready([session(1, "shell", "b", "done")]))).toBe("Houston · idle");
  });

  it("does not count closed sessions", () => {
    const payload = ready([
      session(1, "claude", "live", "idle"),
      session(2, "codex", "finished", "done"),
      session(3, "codex", "interrupted", "error"),
    ]);
    expect(headerText(payload)).toBe("Houston · 1 agent idle");
    expect(submenu(menuModel(payload)).length).toBeGreaterThan(0);
  });

  it("does not call an unreported agent idle", () => {
    expect(headerText(ready([session(1, "claude", "a", "unknown")]))).toBe(
      "Houston · 1 status unknown",
    );
  });

  it("names the connection before the agents", () => {
    for (const [connection, expected] of [
      ["failed", "Houston · daemon not running"],
      ["connecting", "Houston · disconnected"],
      ["reconnecting", "Houston · disconnected"],
    ] as const) {
      expect(headerText({ connection, sessions: [session(1, "claude", "a", "running")] })).toBe(
        expected,
      );
    }
  });

  it("gives every status its own glyph", () => {
    const all: readonly DesktopTrayStatus[] = [
      "running",
      "idle",
      "needsInput",
      "unknown",
      "done",
      "error",
    ];
    const glyphs = all.map(statusGlyph);
    expect(glyphs).toEqual(["●", "○", "◐", "?", "✓", "✕"]);
    expect(new Set(glyphs).size).toBe(all.length);
  });

  it("orders a session row as glyph, agent, then name", () => {
    expect(sessionLabel(session(7, "claude", "refactor auth", "needsInput"))).toBe(
      "◐ Claude · refactor auth",
    );
    expect(sessionLabel(session(7, "opencode", "sweep", "running"))).toBe("● OpenCode · sweep");
  });

  it("title-cases an unlisted agent kind", () => {
    expect(agentLabel("someNewCli")).toBe("SomeNewCli");
    expect(agentLabel("")).toBe("Agent");
  });

  it("builds one separator into an idle menu", () => {
    expect(menuModel(ready([]))).toEqual([
      { type: "header", label: "Houston · idle" },
      { type: "open" },
      { type: "newThread" },
      { type: "separator" },
      { type: "quit" },
    ]);
  });

  it("keeps a single session in the submenu rather than at the top level", () => {
    expect(menuModel(ready([session(1, "claude", "a", "running")]))).toEqual([
      { type: "header", label: "Houston · 1 agent running" },
      { type: "open" },
      { type: "newThread" },
      { type: "separator" },
      {
        type: "submenu",
        label: "Agents (1)",
        items: [
          { type: "group", label: "houston" },
          { type: "session", id: threadKey(1), label: "● Claude · a" },
        ],
      },
      { type: "separator" },
      { type: "quit" },
    ]);
  });

  it("caps attention rows inline and names the hidden count", () => {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      session(index + 1, "claude", `pane ${index + 1}`, "needsInput"),
    );
    const items = menuModel(ready(sessions));
    const inline = items
      .filter((item): item is Extract<TrayItem, { type: "session" }> => item.type === "session")
      .map((item) => item.id);
    expect(inline).toEqual([1, 2, 3, 4].map(threadKey));
    expect(items).toContainEqual({ type: "overflow", label: "+2 more waiting, in Agents" });
  });

  it("adds no overflow row exactly at the attention cap", () => {
    const sessions = Array.from({ length: ATTENTION_ROW_CAP }, (_, index) =>
      session(index + 1, "claude", "pane", "needsInput"),
    );
    expect(menuModel(ready(sessions)).some((item) => item.type === "overflow")).toBe(false);
  });

  it("puts a running pane only in the submenu", () => {
    const items = menuModel(
      ready([
        session(1, "claude", "waiting", "needsInput"),
        session(2, "codex", "running", "running"),
      ]),
    );
    const topLevel = items
      .filter((item): item is Extract<TrayItem, { type: "session" }> => item.type === "session")
      .map((item) => item.id);
    expect(topLevel).toEqual([threadKey(1)]);
    const submenuIds = submenu(items)
      .filter((item): item is Extract<TrayItem, { type: "session" }> => item.type === "session")
      .map((item) => item.id);
    expect(submenuIds).toEqual([threadKey(1), threadKey(2)]);
  });

  it("groups the submenu by workspace in first-appearance order", () => {
    const items = menuModel(
      ready([
        sessionIn(1, "claude", "a", "idle", "beta"),
        sessionIn(2, "codex", "b", "idle", "alpha"),
        sessionIn(3, "shell", "c", "idle", "beta"),
      ]),
    );
    const groups = submenu(items)
      .filter((item): item is Extract<TrayItem, { type: "group" }> => item.type === "group")
      .map((item) => item.label);
    expect(groups).toEqual(["beta", "alpha"]);
  });

  it("sorts each group by attention, then running, then idle, keeping payload order", () => {
    const items = menuModel(
      ready([
        sessionIn(1, "claude", "idle-a", "idle", "ws"),
        sessionIn(2, "codex", "done", "done", "ws"),
        sessionIn(3, "shell", "running", "running", "ws"),
        sessionIn(4, "claude", "needs-input", "needsInput", "ws"),
        sessionIn(5, "claude", "idle-b", "idle", "ws"),
      ]),
    );
    const ids = submenu(items)
      .filter((item): item is Extract<TrayItem, { type: "session" }> => item.type === "session")
      .map((item) => item.id);
    expect(ids).toEqual([4, 3, 1, 5].map(threadKey));
  });

  it("caps a group and names how many it hid", () => {
    const sessions = Array.from({ length: GROUP_ROW_CAP + 3 }, (_, index) =>
      sessionIn(index + 1, "claude", "pane", "idle", "ws"),
    );
    const sub = submenu(menuModel(ready(sessions)));
    const shown = sub.filter(
      (item): item is Extract<TrayItem, { type: "session" }> => item.type === "session",
    );
    expect(shown).toHaveLength(GROUP_ROW_CAP);
    expect(sub).toContainEqual({ type: "overflow", label: "+3 more in Houston" });
  });

  it("counts every session in the submenu label", () => {
    const sessions = Array.from({ length: 5 }, (_, index) =>
      session(index + 1, "claude", "pane", "idle"),
    );
    expect(menuModel(ready(sessions))).toContainEqual(
      expect.objectContaining({ type: "submenu", label: "Agents (5)" }),
    );
  });

  it("prefers attention over activity for the icon", () => {
    expect(iconState(ready([]))).toBe("idle");
    expect(iconState(ready([session(1, "claude", "a", "running")]))).toBe("active");
    expect(
      iconState(
        ready([session(1, "claude", "a", "running"), session(2, "codex", "b", "needsInput")]),
      ),
    ).toBe("attention");
  });

  it("never claims agents are active while disconnected", () => {
    expect(
      iconState({ connection: "reconnecting", sessions: [session(1, "claude", "a", "running")] }),
    ).toBe("idle");
  });

  it("sizes the icon from the base size and the scale factor", () => {
    for (const [scale, cut] of [
      [1, 16],
      [1.25, 20],
      [1.5, 24],
      [2, 32],
      [2.5, 40],
    ] as const) {
      expect(iconSizeFor(16, scale)).toBe(cut);
    }
    expect(iconSizeFor(22, 1)).toBe(22);
    expect(iconSizeFor(22, 2)).toBe(44);
    expect(iconSizeFor(22, undefined)).toBe(22);
  });

  it("uses 16px on GNOME panels and Windows, 22 elsewhere", () => {
    expect(baseIconSize("linux", "GNOME")).toBe(16);
    expect(baseIconSize("linux", "ubuntu:GNOME")).toBe(16);
    expect(baseIconSize("linux", "KDE")).toBe(22);
    expect(baseIconSize("linux", undefined)).toBe(22);
    expect(baseIconSize("win32", undefined)).toBe(16);
    expect(baseIconSize("win32", "GNOME")).toBe(16);
  });

  it("names a tray icon file for every state and cut", () => {
    expect(trayIconFile("idle", 22)).toBe("tray/idle-22.png");
    expect(trayIconFile("active", 16)).toBe("tray/active-16.png");
    expect(trayIconFile("attention", 48)).toBe("tray/attention-48.png");
  });
});
