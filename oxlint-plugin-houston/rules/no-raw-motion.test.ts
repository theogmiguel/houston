import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("houston/no-raw-motion", { filename: "fixture.tsx" });

describe("houston/no-raw-motion", () => {
  rule.valid(
    "allows motion roles and named easings",
    `const el = <div className="transition-[opacity,scale] duration-(--motion-overlay-in) ease-standard data-ending-style:duration-(--motion-overlay-out) data-ending-style:ease-exit" />;`,
  );

  rule.valid("allows turning motion off", `const c = "transition-none duration-0 delay-0";`);

  rule.valid("allows the drawer curve", `const c = cn("ease-drawer", open && "opacity-100");`);

  rule.invalid(
    "reports a raw duration with its value",
    `const el = <div className="transition-opacity duration-150" />;`,
    (output) => {
      assert.match(output, /duration-150/);
      assert.match(output, /--motion-overlay-in/);
    },
  );

  rule.invalid(
    "reports a raw duration behind variants",
    `const c = "data-[state=open]:motion-safe:duration-[180ms]";`,
    (output) => {
      assert.match(output, /duration-\[180ms\]/);
    },
  );

  rule.invalid("reports transition-all", `const c = cn("transition-all", x);`, (output) => {
    assert.match(output, /transition-all/);
  });

  rule.invalid("reports a raw easing", "const c = `ease-out ${x}`;", (output) => {
    assert.match(output, /ease-out/);
  });

  rule.invalid(
    "reports a raw transition shorthand",
    `const c = "[transition:transform_.5s_cubic-bezier(.22,1,.36,1)]";`,
    (output) => {
      assert.match(output, /raw transition shorthand/);
    },
  );
});
