import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  compareToBaseline,
  LOAD_FAILURE,
  parseBaseline,
  readReport,
  serverRelativeFile,
} from "./windows-known-failures.mjs";

const suite = (name, status, tests) => ({
  name,
  status,
  assertionResults: tests.map(([ancestorTitles, title, testStatus]) => ({
    ancestorTitles,
    title,
    status: testStatus,
  })),
});

NodeTest.test("keys a Windows path relative to apps/server", () => {
  NodeAssert.equal(
    serverRelativeFile("D:\\a\\houston\\houston\\apps\\server\\src\\cli\\update.test.ts"),
    "src/cli/update.test.ts",
  );
});

NodeTest.test("rejects a report file outside apps/server, naming the path", () => {
  NodeAssert.throws(() => serverRelativeFile("D:\\a\\other\\x.test.ts"), /D:\\\\a\\\\other/);
});

NodeTest.test("reads failed tests with their describe path and files that failed to load", () => {
  const { ranFiles, failures } = readReport({
    testResults: [
      suite("/w/apps/server/src/a.test.ts", "failed", [
        [["outer", "inner"], "breaks", "failed"],
        [[], "works", "passed"],
      ]),
      suite("/w/apps/server/src/b.test.ts", "failed", []),
      suite("/w/apps/server/src/c.test.ts", "passed", [[[], "works", "passed"]]),
    ],
  });
  NodeAssert.deepEqual([...ranFiles].sort(), ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"]);
  NodeAssert.deepEqual([...failures].sort(), [
    "src/a.test.ts > outer > inner > breaks",
    `src/b.test.ts > ${LOAD_FAILURE}`,
  ]);
});

NodeTest.test(
  "flags new failures and listed tests that now pass, ignoring other shards' entries",
  () => {
    const result = {
      ranFiles: new Set(["src/a.test.ts", "src/b.test.ts"]),
      failures: new Set(["src/a.test.ts > known", "src/a.test.ts > new"]),
    };
    const baseline = {
      failing: ["src/a.test.ts > known", "src/b.test.ts > fixed", "src/z.test.ts > other shard"],
      flaky: [],
    };
    NodeAssert.deepEqual(compareToBaseline(result, baseline), {
      unexpected: ["src/a.test.ts > new"],
      fixed: ["src/b.test.ts > fixed"],
    });
  },
);

NodeTest.test("accepts a shard whose failures are all listed", () => {
  const result = {
    ranFiles: new Set(["src/a.test.ts"]),
    failures: new Set(["src/a.test.ts > known"]),
  };
  NodeAssert.deepEqual(
    compareToBaseline(result, { failing: ["src/a.test.ts > known"], flaky: [] }),
    { unexpected: [], fixed: [] },
  );
});

NodeTest.test("accepts a flaky entry whether it fails or passes", () => {
  const baseline = { failing: [], flaky: ["src/a.test.ts > flaky"] };
  const ranFiles = new Set(["src/a.test.ts"]);
  for (const failures of [new Set(["src/a.test.ts > flaky"]), new Set()]) {
    NodeAssert.deepEqual(compareToBaseline({ ranFiles, failures }, baseline), {
      unexpected: [],
      fixed: [],
    });
  }
});

NodeTest.test("rejects a baseline without both lists, naming the expected shape", () => {
  NodeAssert.throws(() => parseBaseline(["src/a.test.ts > known"]), /"failing": string\[\]/);
  NodeAssert.deepEqual(parseBaseline({ failing: ["x > y"], flaky: [] }), {
    failing: ["x > y"],
    flaky: [],
  });
});

NodeTest.test("rejects something that is not a vitest JSON report, naming its keys", () => {
  NodeAssert.throws(() => readReport({ results: [] }), /\["results"\]/);
});
