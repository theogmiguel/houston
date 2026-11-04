import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { LocalServerStatusBanner } from "./LocalServerStatusBanner";

it("shows why a retry failed when the host rejects with a string", async () => {
  const failed: DesktopLocalServerStatus = { state: "error", error: "The server exited." };
  const refusal =
    "not restarting the v2 server: pid 4242 may still be the server, so Houston keeps its record and does not signal it";
  using _bridge = stubGlobal("hostBridge", {
    getServerStatus: async () => failed,
    onServerStatus: () => () => undefined,
    // The desktop host rejects its commands with the error text itself.
    restartServer: () => Promise.reject(refusal),
  });

  await using screen = await render(<LocalServerStatusBanner />);
  await screen.getByRole("button", { name: "Retry" }).click();
  await expect.element(screen.getByText(refusal)).toBeVisible();
});
