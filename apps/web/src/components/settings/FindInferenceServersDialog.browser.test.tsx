import type { EnvironmentId } from "@houston-app/contracts";
import type { InferenceDiscoveredServer } from "@houston-app/contracts/houston/inference";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const found = {
  baseUrl: "http://localhost:8000/v1",
  engine: "vLLM",
  status: "ready",
  models: [{ id: "served-model" }],
} as unknown as InferenceDiscoveredServer;

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { servers: [found], searchedListeningPorts: true },
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import { FindInferenceServersDialog } from "./FindInferenceServersDialog";

// The settings page swaps this dialog for the add form when a result is picked.
function Owner() {
  const [dialog, setDialog] = useState<"find" | { readonly add: string } | null>("find");
  if (dialog === "find") {
    return (
      <FindInferenceServersDialog
        environmentId={"env" as EnvironmentId}
        environmentLabel="this machine"
        onClose={() => setDialog(null)}
        onPick={(server) => setDialog({ add: server.baseUrl })}
      />
    );
  }
  return <p>{dialog === null ? "closed" : `adding ${dialog.add}`}</p>;
}

describe("FindInferenceServersDialog", () => {
  it("opens the add form for the picked server instead of closing everything", async () => {
    const screen = await render(<Owner />);
    try {
      await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
      await expect.element(page.getByText("adding http://localhost:8000/v1")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
