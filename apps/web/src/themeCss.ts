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

// @keyframes also has both members, but its deleteRule takes a keyframe selector.
const isRuleParent = (rule: CSSRule): rule is CSSRule & RuleParent =>
  "cssRules" in rule && "deleteRule" in rule && !(rule instanceof CSSKeyframesRule);

/** Returns whether the rule has declarations, and counts the ones it dropped into `dropped`. */
function stripDeclarations(rule: CSSRule, dropped: { count: number }): boolean {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    if (themeCssValueFetches(rule.style.getPropertyValue(property))) {
      rule.style.removeProperty(property);
      dropped.count += 1;
    }
  }
  return true;
}

/** Keeps only rule shapes it can check, so a new at-rule that fetches is dropped by default. */
function stripFetches(parent: RuleParent, dropped: { count: number }): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    const hasStyle = stripDeclarations(rule, dropped);
    if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) stripDeclarations(frame, dropped);
    } else if (isRuleParent(rule)) {
      stripFetches(rule, dropped);
    } else if (rule instanceof CSSPropertyRule) {
      // A registered property's initial value is used wherever var() reads it.
      if (themeCssValueFetches(rule.initialValue ?? "")) {
        parent.deleteRule(index);
        dropped.count += 1;
      }
    } else if (
      !hasStyle &&
      !(rule instanceof CSSLayerStatementRule) &&
      // Names a namespace without loading it. CSSOM refuses to delete one while style rules remain.
      !(rule instanceof CSSNamespaceRule)
    ) {
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
