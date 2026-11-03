import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@houston-app/contracts";

import "~/index.css";
import { render } from "../../../test/render";
import { providerClients } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

function claudeForm(unsetBooleanValues?: Readonly<Record<string, boolean>>) {
  const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
  if (claude === undefined) throw new Error("The claudeAgent provider client is not registered.");
  return (
    <ProviderSettingsForm
      definition={claude}
      value={{}}
      idPrefix="claude"
      variant="settings"
      onChange={() => {}}
      unsetBooleanValues={unsetBooleanValues}
    />
  );
}

describe("ProviderSettingsForm unset switches", () => {
  it("shows Claude in Chrome on when Claude Code's own default is on", async () => {
    await using screen = await render(claudeForm({ claudeInChrome: true }));
    await expect.element(screen.getByRole("switch", { name: "Claude in Chrome" })).toBeChecked();
  });

  it("shows Claude in Chrome off when nothing says otherwise", async () => {
    await using screen = await render(claudeForm());
    await expect
      .element(screen.getByRole("switch", { name: "Claude in Chrome" }))
      .not.toBeChecked();
  });
});
