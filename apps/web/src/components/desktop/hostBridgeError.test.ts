import { expect, it } from "vite-plus/test";

import { hostBridgeErrorMessage } from "./hostBridgeError";

it("uses the host's string rejection as the message", () => {
  expect(hostBridgeErrorMessage("not restarting the v2 server: pid 4242", "Fallback.")).toBe(
    "not restarting the v2 server: pid 4242",
  );
  expect(hostBridgeErrorMessage(new Error("bridge closed"), "Fallback.")).toBe("bridge closed");
});

it("falls back when the cause carries no message", () => {
  for (const cause of [undefined, null, 42, { error: "x" }, "", "  ", new Error("")]) {
    expect(hostBridgeErrorMessage(cause, "Fallback.")).toBe("Fallback.");
  }
});
