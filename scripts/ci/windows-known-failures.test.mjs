import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  compareToBaseline,
  LOAD_FAILURE,
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
    const baseline = [
      "src/a.test.ts > known",
      "src/b.test.ts > fixed",
      "src/z.test.ts > other shard",
    ];
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
  NodeAssert.deepEqual(compareToBaseline(result, ["src/a.test.ts > known"]), {
    unexpected: [],
    fixed: [],
  });
});

NodeTest.test("rejects something that is not a vitest JSON report, naming its keys", () => {
  NodeAssert.throws(() => readReport({ results: [] }), /\["results"\]/);
});
