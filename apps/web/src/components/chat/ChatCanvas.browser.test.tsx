import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ChatCanvas } from "./ChatCanvas";
import { createChatCanvasStore } from "./canvasStore";
import { SubagentParentHeader } from "./SubagentParentHeader";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

it("measures where a subagent's parent strip ends so the details card can sit below it", async () => {
  const store = createChatCanvasStore();
  await using screen = await render(
    <div style={{ width: 1200, height: 800, display: "flex" }}>
      <ChatCanvas
        store={store}
        threadRef={threadRef}
        preview={null}
        composerOverlayElement={null}
        parentStripShown
      >
        <SubagentParentHeader title="Parent" onOpen={() => {}} />
      </ChatCanvas>
    </div>,
  );
  const strip = screen.container.querySelector<HTMLElement>("[data-subagent-parent-header]")!;
  await expect
    .poll(() => store.getState().measurements.parentStripBottom)
    .toBe(strip.getBoundingClientRect().height);
  expect(store.getState().measurements.parentStripBottom).toBeGreaterThan(0);
});
