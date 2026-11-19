import type { DesktopWslState } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { WslBackendStatus } from "./WslBackendStatus";

const state: DesktopWslState = {
  enabled: true,
  distro: "Ubuntu",
  available: true,
  wslOnly: false,
  distros: [],
  preflightError: null,
  backendStatus: {
    phase: "failed",
    reason: "The Houston state directory in Ubuntu is owned by PID 4242 in distro Ubuntu.",
  },
};

describe("WslBackendStatus", () => {
  it("renders the failed backend's distro and reason", async () => {
    await using screen = await render(<WslBackendStatus state={state} />, { router: false });

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "The WSL backend couldn't start in the Ubuntu distro: The Houston state directory in Ubuntu is owned by PID 4242 in distro Ubuntu.",
      );
  });
});
