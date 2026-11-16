import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@houston-app/contracts";

import "~/index.css";
import { render } from "../../../test/render";
import { providerClients } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

function claudeForm(value: Record<string, unknown>) {
  const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
  if (claude === undefined) throw new Error("The claudeAgent provider client is not registered.");
  return (
    <ProviderSettingsForm
      definition={claude}
      value={value}
      idPrefix="claude"
      variant="settings"
      onChange={() => {}}
    />
  );
}

describe("Claude provider switches", () => {
  it("shows Claude in Chrome and Artifacts on when never changed", async () => {
    await using screen = await render(claudeForm({}));
    await expect.element(screen.getByRole("switch", { name: "Claude in Chrome" })).toBeChecked();
    await expect.element(screen.getByRole("switch", { name: "Artifacts" })).toBeChecked();
  });

  it("shows a switch the user turned off as off", async () => {
    await using screen = await render(
      claudeForm({ claudeInChrome: false, claudeArtifacts: false }),
    );
    await expect
      .element(screen.getByRole("switch", { name: "Claude in Chrome" }))
      .not.toBeChecked();
    await expect.element(screen.getByRole("switch", { name: "Artifacts" })).not.toBeChecked();
  });
});
