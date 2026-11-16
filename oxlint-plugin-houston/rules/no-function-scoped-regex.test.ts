import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("houston/no-function-scoped-regex");

describe("houston/no-function-scoped-regex", () => {
  rule.valid(
    "allows regexes at module scope",
    `
      const TRAILING_SPACE = /[ \\t]+$/;
      const SEPARATOR = new RegExp("\\\\s*,\\\\s*", "u");

      export const trim = (line: string) => line.replace(TRAILING_SPACE, "");
      export const split = (line: string) => line.split(SEPARATOR);
    `,
  );

  rule.valid(
    "allows a RegExp built from runtime input",
    `
      export const matcher = (word: string) => new RegExp(word, "i");
      export const prefixed = (prefix: string) => RegExp(\`^\${prefix}\`);
    `,
  );

  rule.valid(
    "allows regexes in callbacks serialized into a page",
    `
      declare const page: { evaluate<T>(fn: () => T): Promise<T> };

      export const readTitle = () =>
        page.evaluate(() => document.title.replace(/\\s+/g, " "));
    `,
  );

  rule.invalid(
    "reports a regex literal inside a function",
    `
      export const trim = (line: string) => line.replace(/[ \\t]+$/, "");
    `,
    (output) => {
      assert.match(output, /Hoist this regex to a module-level const/);
    },
  );

  rule.invalid(
    "reports a regex literal inside a class method",
    `
      export class Parser {
        isHeader(line: string) {
          return /^#+\\s/.test(line);
        }
      }
    `,
  );

  rule.invalid(
    "reports a static RegExp construction inside a function",
    `
      export function split(line: string) {
        return line.split(new RegExp("\\\\s*,\\\\s*"));
      }
    `,
  );

  rule.invalid(
    "reports a static RegExp call beside a serialized callback",
    `
      declare const page: { evaluate<T>(fn: () => T): Promise<T> };

      export const readTitle = async () => {
        const title = await page.evaluate(() => document.title);
        return title.replace(RegExp("\\\\s+", "g"), " ");
      };
    `,
  );
});
