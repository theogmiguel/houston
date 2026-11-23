import { EnvironmentId } from "@houston-app/contracts";
import { serverUpdateStateAtom } from "@houston-app/client-runtime/state/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import {
  setUpdateEverythingRun,
  startDesktopUpdateLaunchNotice,
  waitForServerUpdateStarted,
} from "./updateEverythingRun";

function relaunchWhileRestarting(environmentId: EnvironmentId) {
  const now = 1_800_000_000_000;
  vi.useFakeTimers({ now });
  const store = new Map([
    [
      "houston:update-everything-result:v1",
      JSON.stringify({
        savedAt: now,
        localVersion: null,
        updatedServers: 0,
        updatedProviders: 0,
        failures: [],
        handedOff: [{ environmentId, label: "Slow", targetVersion: "9.9.9", startedAt: now }],
      }),
    ],
  ]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
  return startDesktopUpdateLaunchNotice();
}

describe("startDesktopUpdateLaunchNotice", () => {
  afterEach(() => {
    setUpdateEverythingRun(() => null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a server that is still restarting from looking idle after the app relaunches", async () => {
    const environmentId = EnvironmentId.make("slow-machine");
    const stop = relaunchWhileRestarting(environmentId);
    try {
      // Lets the registry run its cleanup of unobserved atoms before the UI mounts.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appAtomRegistry.get(serverEnvironment.updateStateAtom(environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
        targetVersion: "9.9.9",
      });
    } finally {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      stop();
    }
  });

  it("resumes the servers a window reload saved mid-run", async () => {
    const environmentId = EnvironmentId.make("reloading-machine");
    const now = 1_800_000_000_000;
    vi.useFakeTimers({ now });
    const store = new Map([
      [
        "houston:update-everything-run:v1",
        JSON.stringify({
          savedAt: now,
          handedOff: [
            { environmentId, label: "Reloading", targetVersion: "9.9.9", startedAt: now },
          ],
        }),
      ],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
    const stop = startDesktopUpdateLaunchNotice();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appAtomRegistry.get(serverEnvironment.updateStateAtom(environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
        targetVersion: "9.9.9",
      });
      expect(store.has("houston:update-everything-run:v1")).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      stop();
    }
  });

  it("reports a server trigger as started without waiting for its handoff", async () => {
    const environmentId = EnvironmentId.make("triggered-machine");
    let finishHandoff = () => {};
    const handoff = new Promise<void>((resolve) => {
      finishHandoff = resolve;
    });
    const stateAtom = serverUpdateStateAtom(environmentId);
    const release = appAtomRegistry.mount(stateAtom);
    try {
      const started = waitForServerUpdateStarted(environmentId, handoff);
      appAtomRegistry.set(stateAtom, {
        status: "running",
        stage: "downloading",
        fromVersion: "1.0.0",
        targetVersion: "9.9.9",
      });
      await expect(started).resolves.toBeUndefined();
      expect(appAtomRegistry.get(stateAtom)).toMatchObject({ stage: "downloading" });
    } finally {
      finishHandoff();
      release();
    }
  });

  it("clears the restored state when the server never comes back", async () => {
    const environmentId = EnvironmentId.make("lost-machine");
    const stateAtom = serverEnvironment.updateStateAtom(environmentId);
    const stop = relaunchWhileRestarting(environmentId);
    // Observed like the UI does, so the registry cannot reset it by dropping the atom.
    const release = appAtomRegistry.mount(stateAtom);
    try {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      expect(appAtomRegistry.get(stateAtom)).toEqual({ status: "idle" });
    } finally {
      release();
      stop();
    }
  });
});
