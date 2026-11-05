import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ProviderModelsSection } from "./ProviderModelsSection";

const model: ServerProviderModel = {
  slug: "model-a",
  name: "Model A",
  isCustom: false,
  capabilities: null,
};

it("eases a model row's tint on the feedback role", async () => {
  await using screen = await render(
    <ProviderModelsSection
      instanceId={"instance-1" as ProviderInstanceId}
      driverKind={ProviderDriverKind.make("claudeAgent")}
      models={[model]}
      customModels={[]}
      canManageCustomModels={true}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={() => {}}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
    { router: false },
  );

  const row = screen.container.querySelector<HTMLElement>('[data-model-slug="model-a"]');
  if (row === null) throw new Error("The provider model row is missing.");
  const style = getComputedStyle(row);
  expect(style.transitionProperty).toContain("color");
  expect(style.transitionDuration).toBe("0.1s");
  expect(style.transitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0, 1)");
});
