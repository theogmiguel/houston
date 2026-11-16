import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareToBaseline, formatRegression, groupErrorsByFile } from "./lint-ratchet.mjs";

const error = (filename, line = 1) => ({
  severity: "error",
  filename,
  code: "eslint(no-unused-vars)",
  message: "unused",
  labels: [{ span: { line, column: 1 } }],
});

describe("lint ratchet", () => {
  it("ignores warnings when counting", () => {
    const grouped = groupErrorsByFile([{ ...error("a.ts"), severity: "warning" }, error("a.ts")]);
    assert.equal(grouped.get("a.ts").length, 1);
  });

  it("allows a file to keep its baseline count", () => {
    const { regressions } = compareToBaseline(groupErrorsByFile([error("a.ts"), error("a.ts")]), {
      "a.ts": 2,
    });
    assert.deepEqual(regressions, []);
  });

  it("fails when a file gains an error", () => {
    const { regressions } = compareToBaseline(groupErrorsByFile([error("a.ts"), error("a.ts")]), {
      "a.ts": 1,
    });
    assert.equal(regressions.length, 1);
    assert.equal(regressions[0].count, 2);
    assert.equal(regressions[0].allowed, 1);
  });

  it("fails on an error in a file with no baseline entry", () => {
    const { regressions } = compareToBaseline(groupErrorsByFile([error("new.ts")]), {});
    assert.equal(regressions[0].allowed, 0);
  });

  it("reports files below their baseline as improvements, not failures", () => {
    const { regressions, improvements } = compareToBaseline(groupErrorsByFile([error("a.ts")]), {
      "a.ts": 3,
      "gone.ts": 1,
    });
    assert.deepEqual(regressions, []);
    assert.deepEqual(improvements.map((i) => i.file).toSorted(), ["a.ts", "gone.ts"]);
  });

  it("judges only the files in scope", () => {
    const grouped = groupErrorsByFile([error("a.ts"), error("b.ts")]);
    const { regressions } = compareToBaseline(grouped, {}, new Set(["a.ts"]));
    assert.deepEqual(
      regressions.map((r) => r.file),
      ["a.ts"],
    );
  });

  it("names the file, the count, the allowance and the offending lines", () => {
    const [regression] = compareToBaseline(groupErrorsByFile([error("a.ts", 7)]), {}).regressions;
    const text = formatRegression(regression);
    assert.match(text, /a\.ts has 1 lint error\(s\), baseline allows 0/);
    assert.match(text, /a\.ts:7:1 eslint\(no-unused-vars\): unused/);
  });
});
