import type { EnvironmentId } from "@houston-app/contracts";
import type { SecretRequestItem } from "@houston-app/client-runtime/secret-request";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SecretRequestCard } from "./SecretRequestCard";

vi.mock("../../state/server", () => {
  const config = Atom.make(null);
  return {
    serverEnvironment: {
      answerSecretRequest: { label: "answer secret request" },
      configValueAtom: () => config,
    },
  };
});
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({}),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));

const LONG_REASON =
  "The deploy command reads the signing secret from the environment so it can verify " +
  "incoming webhooks. Create a restricted key with only the webhook scope, paste it here, " +
  "and the agent will hand it to the command for this run.";

function secretRequest(overrides: Partial<SecretRequestItem> = {}): SecretRequestItem {
  return {
    type: "secret_request",
    id: "turn-item:test",
    threadId: "thread:test",
    label: "Stripe webhook secret",
    reason: LONG_REASON,
    secretStatus: "pending",
    ...overrides,
  } as unknown as SecretRequestItem;
}

describe("SecretRequestCard", () => {
  it("clamps a long agent description and expands it on demand", async () => {
    await using screen = await render(
      <SecretRequestCard
        environmentId={"local" as EnvironmentId}
        item={secretRequest()}
        visibility="local"
      />,
    );

    const reason = screen.getByText(LONG_REASON);
    expect(reason.element().className).toContain("line-clamp-3");

    await userEvent.click(screen.getByRole("button", { name: "Show more" }).element());

    expect(screen.getByText(LONG_REASON).element().className).not.toContain("line-clamp-3");
    await expect.element(screen.getByRole("button", { name: "Show less" })).toBeVisible();
  });

  it("states where a file-delivered secret goes in one clause", async () => {
    await using screen = await render(
      <SecretRequestCard
        environmentId={"local" as EnvironmentId}
        item={secretRequest({ delivery: "file" })}
        visibility="local"
      />,
    );

    await expect
      .element(screen.getByText("Out of chat, in a private file the agent can read for 24 hours"))
      .toBeVisible();
  });

  it("keeps the keychain note short", async () => {
    await using screen = await render(
      <SecretRequestCard
        environmentId={"local" as EnvironmentId}
        item={secretRequest()}
        visibility="local"
      />,
    );

    await expect
      .element(screen.getByText("Stored securely, never shown to the agent"))
      .toBeVisible();
  });
});
