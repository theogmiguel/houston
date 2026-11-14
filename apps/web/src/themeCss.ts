import { THEME_CSS_MAX_LENGTH } from "@houston-app/contracts";
import {
  themeCssLoadsRemoteFiles,
  themeCssValueFetches,
  themeCssWithoutComments,
} from "@houston-app/shared/themeCss";

// Theme CSS comes from imported files and from agents, so it must not fetch: a
// url() on an attribute selector can send what is on screen to another host.
// The browser parses the text first, so the checks see normalized values and
// CSS escapes in a function name cannot dodge them.

let themeSheet: CSSStyleSheet | null = null;
let appliedCss = "";
let appliedDropped = 0;

type RuleParent = Pick<CSSStyleSheet, "cssRules" | "deleteRule">;

// The only rule types a theme may keep. A type the engine adds later is unknown here, so it is
// dropped until someone decides how to check it. Names are looked up at run time because an
// older engine may lack some of them.
const DECLARATION_RULES = ["CSSStyleRule", "CSSFontFaceRule", "CSSNestedDeclarations"];
const GROUPING_RULES = [
  "CSSStyleRule",
  "CSSMediaRule",
  "CSSSupportsRule",
  "CSSContainerRule",
  "CSSLayerBlockRule",
  "CSSScopeRule",
  "CSSStartingStyleRule",
];
// Neither loads anything: one orders layers, the other names a namespace. CSSOM also refuses
// to delete a namespace rule while style rules remain.
const INERT_RULES = ["CSSLayerStatementRule", "CSSNamespaceRule"];

function isOneOf(rule: CSSRule, names: ReadonlyArray<string>): boolean {
  const scope = globalThis as unknown as Record<string, unknown>;
  return names.some((name) => {
    const type = scope[name];
    return typeof type === "function" && rule instanceof type;
  });
}

/** Counts the declarations it dropped from the rule into `dropped`. */
function stripDeclarations(rule: CSSRule, dropped: { count: number }): void {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return;
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    if (themeCssValueFetches(rule.style.getPropertyValue(property))) {
      rule.style.removeProperty(property);
      dropped.count += 1;
    }
  }
}

/** Whether the rule is a type the guard checks, after its declarations and children are checked. */
function keepsRule(rule: CSSRule, dropped: { count: number }): boolean {
  if (rule instanceof CSSKeyframesRule) {
    for (const frame of rule.cssRules) stripDeclarations(frame, dropped);
    return true;
  }
  // A registered property's initial value is used wherever var() reads it.
  if (rule instanceof CSSPropertyRule) return !themeCssValueFetches(rule.initialValue ?? "");
  const declares = isOneOf(rule, DECLARATION_RULES);
  const groups = isOneOf(rule, GROUPING_RULES);
  if (declares) stripDeclarations(rule, dropped);
  if (groups) stripFetches(rule as CSSRule & RuleParent, dropped);
  return declares || groups;
}

function stripFetches(parent: RuleParent, dropped: { count: number }): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    // A namespace rule's url() is a name, never an address to load.
    if (!rule || isOneOf(rule, INERT_RULES)) continue;
    // The second check reads the whole rule as the engine serializes it, so a fetch or an
    // escape in a part no branch above looks at (a selector, an at-rule's condition) still
    // drops the rule.
    if (!keepsRule(rule, dropped) || themeCssValueFetches(rule.cssText)) {
      parent.deleteRule(index);
      dropped.count += 1;
    }
  }
}

/**
 * Applies `css` after the app's own styles, replacing the previous theme's, and returns how
 * many declarations or rules the guard dropped. Without a DOM it applies nothing.
 */
export function applyThemeCss(css: string | undefined): number {
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return 0;
  const next = css ?? "";
  if (next === appliedCss) return appliedDropped;
  appliedCss = next;
  if (!themeSheet) {
    // Adopted sheets order after the document's own, and they cannot hold @import.
    themeSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, themeSheet];
  }
  themeSheet.replaceSync(next);
  const dropped = { count: 0 };
  stripFetches(themeSheet, dropped);
  appliedDropped = dropped.count;
  return appliedDropped;
}

export type ThemeCssCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "too-long"; readonly length: number; readonly limit: number }
  | { readonly kind: "loads-files" }
  | { readonly kind: "backslash" };

/** Early feedback for the editor; the guard in `applyThemeCss` decides what actually applies. */
export function checkThemeCss(css: string): ThemeCssCheck {
  if (css.length > THEME_CSS_MAX_LENGTH) {
    return { kind: "too-long", length: css.length, limit: THEME_CSS_MAX_LENGTH };
  }
  if (themeCssLoadsRemoteFiles(css)) return { kind: "loads-files" };
  // The guard refuses a value that still has a backslash, since an escape can spell `url`.
  return themeCssWithoutComments(css).includes("\\") ? { kind: "backslash" } : { kind: "ok" };
}
