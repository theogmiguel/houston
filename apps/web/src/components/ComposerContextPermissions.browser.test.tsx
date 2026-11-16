import type { RuntimeMode } from "@houston-app/contracts";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../test/render";
import { runtimeModeConfig, runtimeModeOptions } from "./chat/runtimeModeConfig";
import { ComposerContextPermissions } from "./ComposerContextPermissions";
import { TooltipProvider } from "./ui/tooltip";

const options = runtimeModeOptions.map((mode) => ({ mode, ...runtimeModeConfig[mode] }));

function Strip() {
  const [mode, setMode] = useState<RuntimeMode>("full-access");
  return (
    <TooltipProvider delay={0}>
      <ComposerContextPermissions
        runtimeMode={mode}
        runtimeModeOptions={options}
        onRuntimeModeChange={setMode}
      />
      <p role="status">{mode}</p>
    </TooltipProvider>
  );
}

it("names the permissions in the strip and changes them from a menu it opens", async () => {
  await using _screen = await render(<Strip />, { router: false });

  const trigger = page.getByRole("button", { name: "Permissions: Full access" });
  await expect.element(trigger).toBeVisible();
  // It answers composer.mode while the new-thread strip is shown.
  expect(trigger.element().getAttribute("data-composer-shortcut")).toBe("composer.mode");

  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Supervised" }).click();

  await expect.element(page.getByRole("status")).toHaveTextContent("approval-required");
  await expect.element(page.getByRole("button", { name: "Permissions: Supervised" })).toBeVisible();
});
