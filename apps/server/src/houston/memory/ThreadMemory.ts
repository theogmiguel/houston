import type {
  HoustonThreadMemoryMachine,
  HoustonThreadMemorySample,
  HoustonThreadMemoryThread,
  HoustonThreadMemoryUnreadable,
  ThreadId,
} from "@houston-app/contracts";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as NodeOS from "node:os";

import * as ServerConfig from "../../config.ts";
import { ownedAgentSlice, parseProcStat } from "../../process/agentScope.ts";

const MEM_TOTAL = /^MemTotal:\s+(\d+)\s+kB$/m;
const MEM_AVAILABLE = /^MemAvailable:\s+(\d+)\s+kB$/m;
const VM_RSS = /^VmRSS:\s+(\d+)\s+kB$/m;
const THREAD_ENV_PREFIX = "HOUSTON_THREAD_ID=";
const NUMERIC = /^\d+$/;

export interface MemoryProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly startTime: number;
  readonly residentBytes: number;
  readonly threadId: string | null;
}

export interface MachineReading {
  readonly totalBytes: number;
  readonly availableBytes: number;
}

export interface CgroupLimit {
  readonly maxBytes: number;
  readonly currentBytes: number;
}

export function parseMeminfo(text: string): MachineReading | null {
  const total = MEM_TOTAL.exec(text)?.[1];
  const available = MEM_AVAILABLE.exec(text)?.[1];
  if (total === undefined || available === undefined) return null;
  const totalBytes = Number(total) * 1024;
  const availableBytes = Number(available) * 1024;
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) return null;
  return { totalBytes, availableBytes };
}

export function parseVmRssBytes(status: string): number | null {
  const value = VM_RSS.exec(status)?.[1];
  if (value === undefined) return null;
  const bytes = Number(value) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/** `HOUSTON_THREAD_ID` from a `/proc/<pid>/environ` body, whose entries are NUL-separated. */
export function parseThreadIdFromEnviron(text: string): string | null {
  for (const entry of text.split("\0")) {
    if (!entry.startsWith(THREAD_ENV_PREFIX)) continue;
    const value = entry.slice(THREAD_ENV_PREFIX.length);
    return value.length > 0 ? value : null;
  }
  return null;
}

export function machineReading(
  totalBytes: number,
  availableBytes: number,
): HoustonThreadMemoryMachine {
  const total = Math.max(0, Math.floor(totalBytes));
  const available = Math.min(total, Math.max(0, Math.floor(availableBytes)));
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: total - available,
    leftPercent: total > 0 ? Math.max(0, Math.min(100, Math.round((available / total) * 100))) : 0,
  };
}

/**
 * Sums the RSS of the process trees owned by `threadIds`. A process belongs to the nearest ancestor
 * that carries a thread marker, so a shared tree is counted once and never against two threads.
 */
export function sumThreadProcesses(
  processes: ReadonlyArray<MemoryProcess>,
  threadIds: ReadonlyArray<string>,
): HoustonThreadMemoryThread | null {
  const wanted = new Set(threadIds);
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const owners = new Set<string>();
  let residentBytes = 0;

  const ownerOf = (process: MemoryProcess): string | null => {
    const seen = new Set<number>();
    let current: MemoryProcess | undefined = process;
    while (current !== undefined) {
      if (current.threadId !== null) return current.threadId;
      if (current.ppid <= 0 || seen.has(current.pid)) return null;
      seen.add(current.pid);
      current = byPid.get(current.ppid);
    }
    return null;
  };

  for (const process of processes) {
    const owner = ownerOf(process);
    if (owner === null || !wanted.has(owner)) continue;
    residentBytes += process.residentBytes;
    owners.add(owner);
  }

  if (owners.size === 0) return null;
  const target = threadIds[0];
  return {
    residentBytes,
    subagentCount: [...owners].filter((owner) => owner !== target).length,
  };
}

function descendantsOf(
  serverPid: number,
  stats: ReadonlyMap<number, { readonly ppid: number }>,
): ReadonlyArray<number> {
  const children = new Map<number, number[]>();
  for (const [pid, stat] of stats) {
    if (stat.ppid <= 0 || stat.ppid === pid) continue;
    const list = children.get(stat.ppid) ?? [];
    list.push(pid);
    children.set(stat.ppid, list);
  }
  const descendants: number[] = [];
  const queue = [...(children.get(serverPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

const readOr = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: A): Effect.Effect<A, never, R> =>
  effect.pipe(Effect.orElseSucceed(() => fallback));

export const readLinuxProcesses = Effect.fn("ThreadMemory.readLinuxProcesses")(function* (
  fs: FileSystem.FileSystem,
  serverPid: number,
  environmentCache: Map<string, string | null>,
) {
  const entries = yield* readOr(fs.readDirectory("/proc"), null);
  if (entries === null) return null;

  const stats = new Map<number, { readonly ppid: number; readonly startTime: number }>();
  for (const entry of entries) {
    if (!NUMERIC.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const stat = yield* readOr(
      fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.map(parseProcStat)),
      undefined,
    );
    if (stat === undefined) continue;
    stats.set(pid, { ppid: stat.ppid, startTime: stat.startTime });
  }

  const processes: MemoryProcess[] = [];
  for (const pid of descendantsOf(serverPid, stats)) {
    const stat = stats.get(pid);
    if (stat === undefined) continue;
    const status = yield* readOr(fs.readFileString(`/proc/${pid}/status`), "");
    const residentBytes = parseVmRssBytes(status);
    if (residentBytes === null) continue;

    const cacheKey = `${pid}:${stat.startTime}`;
    let environment = environmentCache.get(cacheKey);
    if (environment === undefined) {
      environment = yield* readOr(fs.readFileString(`/proc/${pid}/environ`), null);
      environmentCache.set(cacheKey, environment);
    }
    processes.push({
      pid,
      ppid: stat.ppid,
      startTime: stat.startTime,
      residentBytes,
      threadId: environment === null ? null : parseThreadIdFromEnviron(environment),
    });
  }
  return processes;
});

function parseCgroupMax(text: string): number | null {
  const value = text.trim();
  if (value === "max" || value.length === 0) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

export const readCgroupLimit = Effect.fn("ThreadMemory.readCgroupLimit")(function* (
  fs: FileSystem.FileSystem,
  stateDir: string,
) {
  const slice = ownedAgentSlice(stateDir);
  for (const base of [`/sys/fs/cgroup/app-houston.slice/${slice}`, `/sys/fs/cgroup/${slice}`]) {
    const max = parseCgroupMax(yield* readOr(fs.readFileString(`${base}/memory.max`), ""));
    if (max === null) continue;
    const currentText = yield* readOr(fs.readFileString(`${base}/memory.current`), "");
    const current = Number(currentText.trim());
    if (!Number.isSafeInteger(current) || current < 0) continue;
    return { maxBytes: max, currentBytes: current } satisfies CgroupLimit;
  }
  return null;
});

export const readLinuxMachine = Effect.fn("ThreadMemory.readLinuxMachine")(function* (
  fs: FileSystem.FileSystem,
  stateDir: string,
) {
  const meminfo = yield* readOr(fs.readFileString("/proc/meminfo"), null);
  if (meminfo === null) return null;
  const reading = parseMeminfo(meminfo);
  if (reading === null) return null;
  const cgroup = yield* readCgroupLimit(fs, stateDir);
  if (cgroup === null) return machineReading(reading.totalBytes, reading.availableBytes);
  return machineReading(
    Math.min(reading.totalBytes, cgroup.maxBytes),
    Math.min(reading.availableBytes, Math.max(0, cgroup.maxBytes - cgroup.currentBytes)),
  );
});

export class ThreadMemory extends Context.Service<
  ThreadMemory,
  {
    readonly read: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<HoustonThreadMemorySample>;
  }
>()("@houston-app/cli/houston/memory/ThreadMemory") {}

function sample(
  machine: HoustonThreadMemoryMachine | null,
  thread: HoustonThreadMemoryThread | null,
  unreadable: ReadonlyArray<HoustonThreadMemoryUnreadable>,
  sampledAt: number,
): HoustonThreadMemorySample {
  return { sampledAt, machine, thread, unreadable: [...new Set(unreadable)] };
}

export const make = Effect.fn("ThreadMemory.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const config = yield* ServerConfig.ServerConfig;
  const environmentCache = new Map<string, string | null>();
  const warned = yield* Ref.make(false);

  const warnUnreadableOnce = (reason: string) =>
    Ref.getAndSet(warned, true).pipe(
      Effect.flatMap((alreadyWarned) =>
        alreadyWarned
          ? Effect.void
          : Effect.logWarning("Thread memory is unavailable.", { reason }),
      ),
    );

  const readLinux = Effect.fn("ThreadMemory.readLinux")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    const machine = yield* readLinuxMachine(fs, config.stateDir);
    const processes = yield* readLinuxProcesses(fs, process.pid, environmentCache);
    const unreadable: Array<HoustonThreadMemoryUnreadable> = [];
    if (machine === null) unreadable.push("machine");
    if (processes === null) {
      unreadable.push("thread");
      yield* warnUnreadableOnce("process-table");
    }
    const thread = processes === null ? null : sumThreadProcesses(processes, threadIds);
    return sample(
      machine,
      thread,
      unreadable,
      yield* Effect.map(DateTime.now, DateTime.toEpochMillis),
    );
  });

  const readHostMemoryOnly = Effect.fn("ThreadMemory.readHostMemoryOnly")(function* (
    reason: string,
  ) {
    yield* warnUnreadableOnce(reason);
    return sample(
      machineReading(NodeOS.totalmem(), NodeOS.freemem()),
      null,
      ["thread"],
      yield* Effect.map(DateTime.now, DateTime.toEpochMillis),
    );
  });

  return ThreadMemory.of({
    read: Effect.fn("ThreadMemory.read")(function* (threadIds) {
      return yield* platform === "linux"
        ? readLinux(threadIds)
        : readHostMemoryOnly(
            platform === "win32" ? "windows-process-tree" : "unsupported-platform",
          );
    }),
  });
});

export const layer = Layer.effect(ThreadMemory, make());
