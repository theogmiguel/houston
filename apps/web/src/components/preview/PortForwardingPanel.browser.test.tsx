import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, type HostBridge } from "@houston-app/contracts";
import type { PortForward } from "@houston-app/contracts/houston/portForwarding";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

import { PortForwardingPanel } from "./PortForwardingPanel";

const mocks = vi.hoisted(() => ({
  forwards: [] as PortForward[],
  enabled: true,
  started: [] as Array<{ readonly environmentId: string; readonly remotePort: number }>,
  stopped: [] as string[],
}));

vi.mock(import("~/browser/remotePortForwarding"), () => ({
  isRemoteEnvironment: () => true,
}));

vi.mock(import("~/state/portForwards"), () => ({
  usePortForwards: () => mocks.forwards,
}));

vi.mock(import("~/hooks/useSettings"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
      const settings = { ...DEFAULT_CLIENT_SETTINGS, portForwardingEnabled: mocks.enabled };
      return selector === undefined ? settings : selector(settings);
    }) as never,
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const forward: PortForward = {
  id: "forward-1",
  environmentId: ENVIRONMENT_ID,
  environmentLabel: "Build box",
  transport: "ssh",
  remotePort: 5432,
  localPort: 5433,
  state: "active",
  error: null,
};

function setHostBridge(bridge: Partial<HostBridge>) {
  Object.defineProperty(window, "hostBridge", {
    value: bridge as HostBridge,
    configurable: true,
  });
}

async function renderPanel() {
  const container = document.createElement("div");
  container.style.cssText = "width: 400px;";
  return render(<PortForwardingPanel environmentId={ENVIRONMENT_ID} />, { container });
}

describe("PortForwardingPanel", () => {
  it("lists every forward with its local port and stops it", async () => {
    mocks.forwards = [forward];
    mocks.stopped = [];
    setHostBridge({
      startPortForward: async (input: {
        readonly environmentId: string;
        readonly remotePort: number;
      }) => {
        mocks.started.push(input);
        return forward;
      },
      stopPortForward: async ({ id }: { readonly id: string }) => {
        mocks.stopped.push(id);
      },
      listPortForwards: async () => mocks.forwards,
      onPortForwardsChanged: () => () => undefined,
    });

    const screen = await renderPanel();
    await expect.element(screen.getByText("localhost:5433 → Build box:5432")).toBeVisible();
    await screen.getByRole("button", { name: "Stop" }).click();
    expect(mocks.stopped).toEqual(["forward-1"]);
  });

  it("says why the controls are inert while the setting is off", async () => {
    mocks.forwards = [];
    mocks.enabled = false;
    setHostBridge({
      startPortForward: async (input: {
        readonly environmentId: string;
        readonly remotePort: number;
      }) => {
        mocks.started.push(input);
        return forward;
      },
      stopPortForward: async () => undefined,
      listPortForwards: async () => [],
      onPortForwardsChanged: () => () => undefined,
    });

    const screen = await renderPanel();
    await expect
      .element(
        screen.getByText(
          "Port forwarding is off. Turn it on in Settings → Connections → Port forwarding.",
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });
});
