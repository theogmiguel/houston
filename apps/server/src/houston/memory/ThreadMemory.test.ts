import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import { ownedAgentSlice } from "../../process/agentScope.ts";
import {
  machineReading,
  parseMeminfo,
  parseThreadIdFromEnviron,
  parseVmRssBytes,
  readLinuxMachine,
  readLinuxProcesses,
  sumThreadProcesses,
} from "./ThreadMemory.ts";

const KIB = 1024;

function procStat(pid: number, ppid: number, startTime: number): string {
  const fields = [
    "S",
    String(ppid),
    "1",
    "1",
    "0",
    "-1",
    "4194560",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    String(startTime),
  ];
  return `${pid} (agent) ${fields.join(" ")}\n`;
}

function status(rssKib: number): string {
  return `Name:\tagent\nVmRSS:\t  ${rssKib} kB\n`;
}

function fakeFs(
  files: Readonly<Record<string, string>>,
  directories?: Readonly<Record<string, ReadonlyArray<string>>>,
) {
  return FileSystem.makeNoop({
    readDirectory: (path) => {
      const entries = directories?.[path];
      return entries === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readDirectory",
              pathOrDescriptor: path,
            }),
          )
        : Effect.succeed([...entries]);
    },
    readFileString: (path) => {
      const contents = files[path];
      return contents === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
            }),
          )
        : Effect.succeed(contents);
    },
  });
}

describe("memory parsing", () => {
  it("reads MemTotal and MemAvailable from /proc/meminfo", () => {
    expect(
      parseMeminfo("MemTotal:       31457280 kB\nMemFree: 10 kB\nMemAvailable:   14680064 kB\n"),
    ).toEqual({ totalBytes: 30 * 1_048_576 * KIB, availableBytes: 14 * 1_048_576 * KIB });
  });

  it("rejects meminfo without both figures", () => {
    expect(parseMeminfo("MemTotal: 10 kB\n")).toBeNull();
  });

  it("reads VmRSS and the thread marker", () => {
    expect(parseVmRssBytes("Name:\tcodex\nVmRSS:\t  2048 kB\n")).toBe(2_048 * KIB);
    expect(parseThreadIdFromEnviron("PATH=/usr/bin\0HOUSTON_THREAD_ID=thread:a\0")).toBe(
      "thread:a",
    );
    expect(parseThreadIdFromEnviron("PATH=/usr/bin\0")).toBeNull();
  });

  it("keeps available memory inside the total and rounds the percentage", () => {
    expect(machineReading(30 * 1_048_576 * KIB, 16.2 * 1_048_576 * KIB)).toEqual({
      totalBytes: 30 * 1_048_576 * KIB,
      availableBytes: Math.floor(16.2 * 1_048_576 * KIB),
      usedBytes: 30 * 1_048_576 * KIB - Math.floor(16.2 * 1_048_576 * KIB),
      leftPercent: 54,
    });
  });
});

describe("sumThreadProcesses", () => {
  const processes = [
    { pid: 10, ppid: 1, startTime: 1, residentBytes: 100, threadId: "thread:root" },
    { pid: 11, ppid: 10, startTime: 2, residentBytes: 50, threadId: null },
    { pid: 12, ppid: 1, startTime: 3, residentBytes: 200, threadId: "thread:sub" },
    { pid: 13, ppid: 12, startTime: 4, residentBytes: 25, threadId: null },
    { pid: 14, ppid: 1, startTime: 5, residentBytes: 1_000, threadId: "thread:other" },
  ];

  it("sums the thread tree and each sub-agent tree once", () => {
    expect(sumThreadProcesses(processes, ["thread:root", "thread:sub"])).toEqual({
      residentBytes: 375,
      subagentCount: 1,
    });
  });

  it("counts a shared process once, for the nearest thread that owns it", () => {
    expect(sumThreadProcesses(processes, ["thread:root"])).toEqual({
      residentBytes: 150,
      subagentCount: 0,
    });
    expect(sumThreadProcesses(processes, ["thread:sub"])).toEqual({
      residentBytes: 225,
      subagentCount: 0,
    });
  });

  it("returns null when no process carries a requested thread marker", () => {
    expect(sumThreadProcesses(processes, ["thread:missing"])).toBeNull();
  });
});

describe("readLinuxProcesses", () => {
  it.effect("reads the server's descendants with their RSS and thread markers", () =>
    Effect.gen(function* () {
      const fs = fakeFs(
        {
          "/proc/1/stat": procStat(1, 0, 100),
          "/proc/10/stat": procStat(10, 1, 200),
          "/proc/10/status": status(1_000),
          "/proc/10/environ": "PATH=/usr/bin\0HOUSTON_THREAD_ID=thread:root\0",
          "/proc/11/stat": procStat(11, 10, 300),
          "/proc/11/status": status(500),
          "/proc/11/environ": "PATH=/usr/bin\0",
          "/proc/12/stat": procStat(12, 1, 400),
          "/proc/12/status": status(2_000),
          "/proc/12/environ": "HOUSTON_THREAD_ID=thread:sub\0",
          "/proc/13/stat": procStat(13, 1, 500),
          "/proc/13/status": status(4_000),
          "/proc/13/environ": "HOUSTON_THREAD_ID=thread:other\0",
        },
        { "/proc": ["self", "1", "10", "11", "12", "13"] },
      );
      const cache = new Map<string, string | null>();

      const processes = yield* readLinuxProcesses(fs, 1, cache);

      expect(processes?.map((process) => process.pid).toSorted((a, b) => a - b)).toEqual([
        10, 11, 12, 13,
      ]);
      expect(cache.size).toBe(4);
      expect(sumThreadProcesses(processes ?? [], ["thread:root", "thread:sub"])).toEqual({
        residentBytes: 3_500 * KIB,
        subagentCount: 1,
      });
    }),
  );

  it.effect("reports an unreadable process table instead of an empty thread", () =>
    Effect.gen(function* () {
      const processes = yield* readLinuxProcesses(fakeFs({}), process.pid, new Map());
      expect(processes).toBeNull();
    }),
  );
});

describe("readLinuxMachine", () => {
  const stateDir = "/tmp/houston-thread-memory-test";
  const slice = ownedAgentSlice(stateDir);
  const gib = 1_048_576 * KIB;

  it.effect("honours the agents' cgroup limit", () =>
    Effect.gen(function* () {
      const fs = fakeFs({
        "/proc/meminfo": `MemTotal: ${32 * 1_048_576} kB\nMemAvailable: ${20 * 1_048_576} kB\n`,
        [`/sys/fs/cgroup/app-houston.slice/${slice}/memory.max`]: String(24 * gib),
        [`/sys/fs/cgroup/app-houston.slice/${slice}/memory.current`]: String(6 * gib),
      });

      const machine = yield* readLinuxMachine(fs, stateDir);

      expect(machine).toEqual({
        totalBytes: 24 * gib,
        availableBytes: 18 * gib,
        usedBytes: 6 * gib,
        leftPercent: 75,
      });
    }),
  );

  it.effect("falls back to host memory when the cgroup limit is unreadable", () =>
    Effect.gen(function* () {
      const fs = fakeFs({
        "/proc/meminfo": `MemTotal: ${32 * 1_048_576} kB\nMemAvailable: ${20 * 1_048_576} kB\n`,
      });

      const machine = yield* readLinuxMachine(fs, stateDir);

      expect(machine).toEqual({
        totalBytes: 32 * gib,
        availableBytes: 20 * gib,
        usedBytes: 12 * gib,
        leftPercent: 63,
      });
    }),
  );

  it.effect("returns null when /proc/meminfo is unreadable", () =>
    Effect.gen(function* () {
      expect(yield* readLinuxMachine(fakeFs({}), stateDir)).toBeNull();
    }),
  );
});
