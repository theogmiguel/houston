import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ChatCanvas } from "./ChatCanvas";
import { createChatCanvasStore } from "./canvasStore";
import { useChatCanvas, useRegisterChatCanvasTimeline } from "./ChatCanvasContext";
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

it.each([
  [324, 16],
  [520, 16],
  [700, 48],
])("a %ipx chat canvas keeps a %ipx lane gutter in a wide window", async (width, gutter) => {
  const store = createChatCanvasStore();
  await using screen = await render(
    <div style={{ width, height: 600, display: "flex" }}>
      <ChatCanvas
        store={store}
        threadRef={threadRef}
        preview={null}
        composerOverlayElement={null}
        parentStripShown={false}
      >
        <div className="chat-composer-lane" data-lane />
      </ChatCanvas>
    </div>,
  );
  const lane = getComputedStyle(screen.container.querySelector<HTMLElement>("[data-lane]")!);
  expect([lane.paddingLeft, lane.paddingRight]).toEqual([`${gutter}px`, `${gutter}px`]);
  await expect.poll(() => store.getState().measurements.padding).toBe(gutter);
});

function Probe({ onRender, hook }: { onRender: () => void; hook: () => unknown }) {
  hook();
  onRender();
  return null;
}

/** Mounts a canvas around one probe, and resizes it by style so React itself renders nothing. */
async function mountCanvas(hook: () => unknown) {
  const store = createChatCanvasStore();
  const renders = { count: 0 };
  const screen = await render(
    <div data-sized style={{ width: 1200, height: 800, display: "flex" }}>
      <ChatCanvas store={store} threadRef={threadRef} preview={null} composerOverlayElement={null}>
        <Probe hook={hook} onRender={() => (renders.count += 1)} />
      </ChatCanvas>
    </div>,
  );
  const sized = screen.container.querySelector<HTMLElement>("[data-sized]")!;
  await expect.poll(() => store.getState().measurements.height).toBe(800);
  return { screen, store, renders, sized };
}

it("does not re-render its consumers for a resize that moves nothing they draw", async () => {
  const { screen, store, renders, sized } = await mountCanvas(useChatCanvas);
  await using _screen = screen;
  const settled = renders.count;
  sized.style.width = "1230px";
  await expect.poll(() => store.getState().measurements.width).toBe(1230);
  expect(renders.count).toBe(settled);
});

it("re-renders its consumers when a resize changes the height they draw in", async () => {
  const { screen, store, renders, sized } = await mountCanvas(useChatCanvas);
  await using _screen = screen;
  const settled = renders.count;
  sized.style.height = "700px";
  await expect.poll(() => store.getState().measurements.height).toBe(700);
  await expect.poll(() => renders.count).toBeGreaterThan(settled);
});

it("does not re-render the timeline's registration consumer for any canvas change", async () => {
  const { screen, store, renders, sized } = await mountCanvas(useRegisterChatCanvasTimeline);
  await using _screen = screen;
  const settled = renders.count;
  sized.style.height = "700px";
  await expect.poll(() => store.getState().measurements.height).toBe(700);
  expect(renders.count).toBe(settled);
});
