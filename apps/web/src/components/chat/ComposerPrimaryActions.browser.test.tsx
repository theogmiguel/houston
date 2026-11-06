import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderSend(hasSendableContent: boolean) {
  return render(
    <TooltipProvider delay={0}>
      <ComposerPrimaryActions
        compact={false}
        canOperateThread
        pendingAction={null}
        isRunning={false}
        canInterrupt={false}
        showPlanFollowUpPrompt={false}
        promptHasText={hasSendableContent}
        isSendBusy={false}
        sendDisabledReason={null}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={hasSendableContent}
        onSubmitMessage={() => {}}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />
    </TooltipProvider>,
  );
}

function tokenColor(property: "backgroundColor" | "color", value: string) {
  const probe = document.createElement("span");
  document.body.append(probe);
  probe.style[property] = value;
  const resolved = getComputedStyle(probe)[property];
  probe.remove();
  return resolved;
}

function sendButtonStyle() {
  const button = page.getByRole("button", { name: "Submit message" }).element();
  const style = getComputedStyle(button);
  return { disabled: (button as HTMLButtonElement).disabled, style };
}

function rasterColor(cssValue: string): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = cssValue;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const luminance = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function sendGlyphOpacity() {
  const button = page.getByRole("button", { name: "Submit message" }).element();
  return Number(getComputedStyle(button.querySelector("svg")!).opacity);
}

it("keeps the solid accent fill on an empty composer's send button and dims only its glyph", async () => {
  await using _screen = await renderSend(false);
  const { disabled, style } = sendButtonStyle();
  expect(disabled).toBe(true);
  expect(style.opacity).toBe("1");
  expect(style.backgroundColor).toBe(tokenColor("backgroundColor", "var(--accent)"));
  expect(style.color).toBe(tokenColor("color", "var(--primary-foreground)"));
  expect(sendGlyphOpacity()).toBeCloseTo(0.45, 2);
  // Pointer events are off on the button so the wrapper owns the not-allowed cursor.
  const wrapper = page.getByRole("button", { name: "Submit message" }).element().parentElement!;
  expect(getComputedStyle(wrapper).cursor).toBe("not-allowed");
});

it("renders the send button with the full accent fill and a full-strength glyph once there is content", async () => {
  await using _screen = await renderSend(true);
  const { disabled, style } = sendButtonStyle();
  expect(disabled).toBe(false);
  expect(style.opacity).toBe("1");
  expect(style.backgroundColor).toBe(tokenColor("backgroundColor", "var(--accent)"));
  expect(style.color).toBe(tokenColor("color", "var(--primary-foreground)"));
  expect(sendGlyphOpacity()).toBe(1);
  expect(
    getComputedStyle(page.getByRole("button", { name: "Submit message" }).element()).cursor,
  ).toBe("pointer");
});

it("keeps the send glyph at 4.5:1 or better on the accent fill in both themes, enabled or not", async () => {
  const root = document.documentElement;
  try {
    for (const dark of [false, true]) {
      root.classList.toggle("dark", dark);
      for (const sendable of [false, true]) {
        await using _screen = await renderSend(sendable);
        const { style } = sendButtonStyle();
        const fill = style.backgroundColor;
        expect(fill, `dark=${dark} sendable=${sendable}`).toBe(
          tokenColor("backgroundColor", "var(--accent)"),
        );
        expect(
          contrastRatio(rasterColor(style.color), rasterColor(fill)),
          `dark=${dark} sendable=${sendable}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally {
    root.classList.remove("dark");
  }
});
