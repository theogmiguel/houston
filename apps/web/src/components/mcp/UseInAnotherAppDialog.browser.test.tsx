import { EnvironmentId } from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { Result } from "effect";

import { render } from "../../../test/render";

const environmentId = EnvironmentId.make("env-local");
const state = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:3773" as string | null,
  mint: vi.fn(),
  approvalCodes: true as boolean | undefined,
  scopes: ["orchestration:read", "orchestration:operate"] as string[],
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => environmentId,
  useEnvironment: (() => ({ environmentId, label: "This machine" })) as never,
  useEnvironmentHttpBaseUrl: () => state.baseUrl,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map([
      [environmentId, { environment: { capabilities: { mcpApprovalCodes: state.approvalCodes } } }],
    ])) as never,
}));
vi.mock(import("../../state/managedPolicy"), async (original) => ({
  ...(await original()),
  useManagedPolicy: () => undefined,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentSessionState: (() => ({
    data: { authenticated: true, scopes: state.scopes, permissions: state.scopes },
  })) as never,
}));
vi.mock(import("../../state/peerPairingCode"), () => ({
  mintMcpApprovalCodeOn: state.mint,
  mintPairingCodeOn: vi.fn(),
}));

import { UseInAnotherAppDialogHost } from "./UseInAnotherAppDialogHost";
import { openUseInAnotherApp } from "./useInAnotherAppRequest";

const reset = () => {
  state.baseUrl = "http://127.0.0.1:3773";
  state.approvalCodes = true;
  state.scopes = ["orchestration:read", "orchestration:operate"];
  state.mint.mockReset();
};

const open = async () => {
  const screen = await render(<UseInAnotherAppDialogHost />);
  openUseInAnotherApp();
  return screen;
};

it("walks App, Access and Connect, then shows the address, commands and a one-use code", async () => {
  reset();
  state.mint.mockResolvedValue(
    Result.succeed({ credential: "AUTO-Q8RZ3NWD5KTC", expiresAtMs: Date.now() + 5 * 60_000 }),
  );
  await using _screen = await open();

  await page.getByText("Claude Code").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Auto", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  const dialog = (await page.getByRole("dialog").element()).textContent ?? "";
  expect(dialog).toContain("claude mcp add --transport http houston http://127.0.0.1:3773/mcp");
  expect(dialog).toContain("claude mcp login houston");
  // The taller Connect step scrolls inside the dialog, so click the element directly.
  await page.getByRole("button", { name: "Get code" }).click();
  await vi.waitFor(async () =>
    expect((await page.getByRole("dialog").element()).textContent).toContain(
      "AUTO-Q8RZ3NWD5KTCExpires in 5 minutes.",
    ),
  );
  expect(state.mint).toHaveBeenCalledWith(environmentId, "auto");
});

it("offers only the levels this session can approve", async () => {
  reset();
  await using _screen = await open();

  await page.getByText("Codex").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect
    .element(page.getByText('Your session here cannot approve the "full access" level.'))
    .toBeInTheDocument();
});

it("says what is wrong when the environment is too old or not connected", async () => {
  reset();
  state.approvalCodes = false;
  {
    await using _screen = await open();
    await expect.element(page.getByText(/too old to create sign-in codes/)).toBeInTheDocument();
  }
  state.approvalCodes = true;
  state.baseUrl = null;
  await using _again = await open();
  await expect.element(page.getByText(/not connected/)).toBeInTheDocument();
});

it("shows the server's reason when a code cannot be created", async () => {
  reset();
  state.mint.mockResolvedValue(
    Result.fail({ message: "Your session there cannot create pairing codes." }),
  );
  await using _screen = await open();

  await page.getByText("Something else…").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Get code" }).click();

  await expect
    .element(page.getByText("Your session there cannot create pairing codes."))
    .toBeInTheDocument();
});
