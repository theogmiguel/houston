import { defineRule } from "@oxlint/plugins";

// Tailwind variants (`hover:`, `data-open:`, `motion-safe:`, `[&_svg]:`) come before the
// utility; the last colon outside brackets separates them.
function utilityOf(token: string): string {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) cut = index;
  }
  return token.slice(cut + 1).replace(/^!|!$/gu, "");
}

const NAMED_EASES = new Set(["ease-standard", "ease-exit", "ease-drawer"]);

/** Why a utility is a raw motion value, or null when it names a role or does not animate. */
export function rawMotionReason(utility: string): string | null {
  if (utility === "transition-all") {
    return "`transition-all` also animates layout properties; list the properties (`transition-[opacity,scale]`)";
  }
  if (
    /^(duration|delay)-\d+$/u.test(utility) &&
    utility !== "duration-0" &&
    utility !== "delay-0"
  ) {
    return "a raw duration; use a role such as `duration-(--motion-overlay-in)`";
  }
  if (/^(duration|delay)-\[[^\]]*\d(ms|s)\]$/u.test(utility)) {
    return "a raw duration; use a role such as `duration-(--motion-overlay-in)`";
  }
  if (/^ease-/u.test(utility) && !NAMED_EASES.has(utility) && !/^ease-\(--/u.test(utility)) {
    return "a raw easing; use `ease-standard`, `ease-exit` or `ease-drawer`";
  }
  if (/^\[transition:[^\]]*\d(ms|s)/u.test(utility)) {
    return "a raw transition shorthand; use `transition-[…]` with a `duration-(--motion-*)` role";
  }
  return null;
}

/** One message per raw motion class in a class string. */
function rawMotionMessages(text: string): string[] {
  const messages: string[] = [];
  for (const token of text.split(/\s+/u)) {
    if (token.length === 0) continue;
    const reason = rawMotionReason(utilityOf(token));
    if (reason === null) continue;
    messages.push(
      `Raw motion class \`${token}\`: ${reason}. Motion roles live in index.css (--motion-*).`,
    );
  }
  return messages;
}

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow raw Tailwind durations, easings and transition-all; components name a motion role from index.css.",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        for (const message of rawMotionMessages(node.value)) context.report({ node, message });
      },
      TemplateElement(node) {
        for (const message of rawMotionMessages(node.value.cooked ?? node.value.raw)) {
          context.report({ node, message });
        }
      },
    };
  },
});
