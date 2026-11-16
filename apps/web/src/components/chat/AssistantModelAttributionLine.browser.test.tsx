import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { AssistantModelAttributionLine } from "./AssistantModelAttributionLine";

it("names the provider and model under an answer", async () => {
  await using screen = await render(
    <AssistantModelAttributionLine
      attribution={{ providerDisplayName: "Claude", modelLabel: "Sonnet 4.6" }}
    />,
  );

  expect(screen.container.textContent).toBe("Claude · Sonnet 4.6");
});

it("shows nothing when the answer's model is unknown", async () => {
  await using screen = await render(<AssistantModelAttributionLine attribution={null} />);

  expect(screen.container.querySelector("[data-assistant-model-attribution]")).toBeNull();
  expect(screen.container.textContent).toBe("");
});
