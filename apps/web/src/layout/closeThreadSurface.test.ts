import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const confirm = vi.hoisted(() => vi.fn<(labels: readonly string[]) => Promise<boolean>>());

vi.mock(import("../lib/terminalCloseConfirm"), () => ({
  confirmTerminalClose: confirm as never,
  isTerminalCloseConfirmPending: () => false,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

import { useRightPanelStore, selectThreadRightPanelState } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  closeThreadSurface,
  registerSurfaceResourceServices,
  type SurfaceResourceServices,
} from "./closeThreadSurface";
import { THREAD_TERMINAL_SURFACE_ID } from "./layoutModel";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));

function terminalState() {
  return selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  );
}

let services: { [K in keyof SurfaceResourceServices]: ReturnType<typeof vi.fn> };
let unregister: () => void;

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true);
  services = { closeTerminalSession: vi.fn(), releaseSurface: vi.fn() };
  unregister = registerSurfaceResourceServices(services as unknown as SurfaceResourceServices);
  useTerminalUiStateStore.getState().clearTerminalUiState(threadRef);
  useRightPanelStore.setState({ byThreadKey: {} });
});

afterEach(() => unregister());

describe("closeThreadSurface", () => {
  it("ends every session of the thread's terminal and hides it", async () => {
    const terminals = useTerminalUiStateStore.getState();
    terminals.ensureTerminal(threadRef, "default", { open: true, active: true });
    terminals.newTerminal(threadRef, "terminal-2");
    expect(terminalState().terminalIds).toEqual(["default", "terminal-2"]);

    await closeThreadSurface(threadRef, THREAD_TERMINAL_SURFACE_ID);

    expect(confirm).toHaveBeenCalledOnce();
    expect(services.closeTerminalSession.mock.calls.map(([, id]) => id)).toEqual([
      "default",
      "terminal-2",
    ]);
    expect(terminalState().terminalOpen).toBe(false);
  });

  it("leaves the sessions running when the confirmation is declined", async () => {
    useTerminalUiStateStore
      .getState()
      .ensureTerminal(threadRef, "default", { open: true, active: true });
    confirm.mockResolvedValue(false);

    await closeThreadSurface(threadRef, THREAD_TERMINAL_SURFACE_ID);

    expect(services.closeTerminalSession).not.toHaveBeenCalled();
    expect(terminalState().terminalOpen).toBe(true);
  });

  it("does not ask when many tabs close together", async () => {
    useTerminalUiStateStore
      .getState()
      .ensureTerminal(threadRef, "default", { open: true, active: true });

    await closeThreadSurface(threadRef, THREAD_TERMINAL_SURFACE_ID, { bulk: true });

    expect(confirm).not.toHaveBeenCalled();
    expect(services.closeTerminalSession).toHaveBeenCalledWith(threadRef, "default");
  });

  it("drops a panel surface from its store and releases what it held", async () => {
    useRightPanelStore.getState().open(threadRef, "diff");
    const surface = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces[0]!;

    await closeThreadSurface(threadRef, surface.id);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
    expect(services.releaseSurface).toHaveBeenCalledWith(threadRef, surface);
  });

  it("ignores a surface the store no longer holds", async () => {
    await closeThreadSurface(threadRef, "gone");
    expect(services.releaseSurface).not.toHaveBeenCalled();
  });
});
