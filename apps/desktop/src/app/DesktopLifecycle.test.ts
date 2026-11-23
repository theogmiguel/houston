import { assert, describe, it } from "@effect/vitest";

import { terminateLeftoverLinuxChildren } from "./DesktopLifecycle.ts";

const collect = (input: {
  readonly metrics: ReadonlyArray<{ readonly pid: number }>;
  readonly currentPid: number;
}) => {
  const killed: number[] = [];
  const terminated = terminateLeftoverLinuxChildren({
    ...input,
    kill: (pid) => killed.push(pid),
  });
  return { killed, terminated };
};

describe("terminating leftover children at exit", () => {
  it("signals every process Electron reports except this one", () => {
    const { killed, terminated } = collect({
      metrics: [{ pid: 100 }, { pid: 101 }, { pid: 102 }],
      currentPid: 100,
    });
    assert.deepStrictEqual(terminated, [101, 102]);
    assert.deepStrictEqual(killed, [101, 102]);
  });

  it("never signals itself or a non-positive pid", () => {
    const { killed } = collect({
      metrics: [{ pid: 100 }, { pid: 0 }, { pid: -1 }, { pid: 7 }],
      currentPid: 100,
    });
    assert.deepStrictEqual(killed, [7]);
  });

  it("signals a reported pid once", () => {
    const { killed } = collect({
      metrics: [{ pid: 101 }, { pid: 101 }],
      currentPid: 100,
    });
    assert.deepStrictEqual(killed, [101]);
  });
});
