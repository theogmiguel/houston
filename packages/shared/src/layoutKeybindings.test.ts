import {
  LAYOUT_KEYBINDING_COMMANDS,
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
} from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "./keybindings.ts";

const defaults: ReadonlyArray<ResolvedKeybindingRule> = DEFAULT_RESOLVED_KEYBINDINGS;
const isLayoutRule = (rule: ResolvedKeybindingRule) =>
  (LAYOUT_KEYBINDING_COMMANDS as ReadonlyArray<string>).includes(rule.command);
const layoutRules = defaults.filter(isLayoutRule);
const otherRules = defaults.filter((rule) => !isLayoutRule(rule));

type Context = Readonly<Record<string, boolean>>;

function evaluate(node: KeybindingWhenNode | undefined, context: Context): boolean {
  if (!node) return true;
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return context[node.name] === true;
    case "not":
      return !evaluate(node.node, context);
    case "and":
      return evaluate(node.left, context) && evaluate(node.right, context);
    case "or":
      return evaluate(node.left, context) || evaluate(node.right, context);
  }
}

function identifiers(node: KeybindingWhenNode | undefined, into = new Set<string>()): Set<string> {
  if (!node) return into;
  if (node.type === "identifier") {
    if (node.name !== "true" && node.name !== "false") into.add(node.name);
  } else if (node.type === "not") identifiers(node.node, into);
  else {
    identifiers(node.left, into);
    identifiers(node.right, into);
  }
  return into;
}

/** The physical chord a rule presses on a platform, so `mod` is cmd on macOS and ctrl elsewhere. */
function chord(rule: ResolvedKeybindingRule, isMac: boolean): string {
  const { shortcut } = rule;
  return [
    shortcut.key,
    shortcut.metaKey || (shortcut.modKey && isMac) ? "meta" : "",
    shortcut.ctrlKey || (shortcut.modKey && !isMac) ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

/** Whether some context makes both rules apply on a platform, with `isMac` fixed by it. */
function overlap(a: ResolvedKeybindingRule, b: ResolvedKeybindingRule, isMac: boolean): boolean {
  const names = [...new Set([...identifiers(a.whenAst), ...identifiers(b.whenAst)])].filter(
    (name) => name !== "isMac",
  );
  for (let bits = 0; bits < 1 << names.length; bits += 1) {
    const context: Record<string, boolean> = { isMac };
    names.forEach((name, index) => (context[name] = (bits & (1 << index)) !== 0));
    if (evaluate(a.whenAst, context) && evaluate(b.whenAst, context)) return true;
  }
  return false;
}

const label = (rule: ResolvedKeybindingRule) =>
  `${rule.command} ${JSON.stringify(rule.shortcut)} when ${JSON.stringify(rule.whenAst ?? null)}`;

describe("layout keybinding defaults", () => {
  it("declares every layout command in the static command list", () => {
    for (const command of LAYOUT_KEYBINDING_COMMANDS) {
      expect((STATIC_KEYBINDING_COMMANDS as ReadonlyArray<string>).includes(command)).toBe(true);
    }
  });

  it("binds every layout command on macOS, and all but the two workspace-order moves elsewhere", () => {
    const boundOn = (isMac: boolean) =>
      new Set(
        layoutRules
          .filter((rule) => evaluate(rule.whenAst, { isMac, isDesktop: true, terminalFocus: false }))
          .map((rule) => rule.command),
      );
    expect([...boundOn(true)].toSorted()).toEqual([...LAYOUT_KEYBINDING_COMMANDS].toSorted());
    expect(
      LAYOUT_KEYBINDING_COMMANDS.filter((command) => !boundOn(false).has(command)).toSorted(),
    ).toEqual(["layout.moveWorkspaceDown", "layout.moveWorkspaceUp"]);
  });

  it.each([true, false])(
    "never shares a chord with another default in a context that can hold both (macOS: %s)",
    (isMac) => {
      const collisions: string[] = [];
      for (const rule of layoutRules) {
        for (const other of [...otherRules, ...layoutRules]) {
          if (other === rule || chord(other, isMac) !== chord(rule, isMac)) continue;
          if (overlap(rule, other, isMac)) collisions.push(`${label(rule)} / ${label(other)}`);
        }
      }
      expect(collisions).toEqual([]);
    },
  );

  it("keeps the browser's devtools chords off the web build: letter arrows are desktop only", () => {
    const letters = layoutRules.filter(
      (rule) => /^[hjkl]$/.test(rule.shortcut.key) && rule.shortcut.altKey,
    );
    expect(letters).toHaveLength(8);
    for (const rule of letters) {
      expect(evaluate(rule.whenAst, { isMac: true, isDesktop: true })).toBe(true);
      expect(evaluate(rule.whenAst, { isMac: true, isDesktop: false })).toBe(false);
      expect(evaluate(rule.whenAst, { isMac: false, isDesktop: true })).toBe(false);
    }
  });

  it("moves with alt+shift off macOS, where mod is ctrl and ctrl+alt is AltGr on some layouts", () => {
    const focus = layoutRules.filter((rule) => rule.command === "layout.focusLeft");
    const nonMac = focus.find((rule) => evaluate(rule.whenAst, { isMac: false }));
    expect(nonMac?.shortcut).toMatchObject({ key: "arrowleft", altKey: true, shiftKey: true });
    expect(nonMac?.shortcut.modKey).toBe(false);
  });
});
