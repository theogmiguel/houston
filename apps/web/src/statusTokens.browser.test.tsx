import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

type Channels = readonly [number, number, number];

/** The colour a token paints, composited over black for translucent spellings. */
function painted(variable: string): Channels {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${variable})`;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const context = document.createElement("canvas").getContext("2d")!;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = resolved;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance([r, g, b]: Channels): number {
  const [rl, gl, bl] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as unknown as Channels;
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrast(a: Channels, b: Channels): number {
  const [lighter, darker] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function themed(dark: boolean): Disposable {
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  return { [Symbol.dispose]: () => root.classList.remove("dark") };
}

/** Every status ink the glyph set and status words paint. */
const STATUS_INKS = [
  "--status-running-ink",
  "--status-back-ink",
  "--status-waiting-ink",
  "--status-input-ink",
  "--status-approval-ink",
  "--success-foreground",
  "--error-foreground",
] as const;

const STATUS_HUES = [
  "--status-running",
  "--status-back",
  "--status-waiting",
  "--status-input",
  "--status-approval",
  "--success",
  "--error",
] as const;

describe("status colours", () => {
  it.each([false, true])(
    "reads every status ink at 4.5:1 on the canvas and the raised card (dark=%s)",
    (dark) => {
      using _theme = themed(dark);
      const surfaces = [painted("--content"), painted("--card"), painted("--raised")];
      for (const ink of STATUS_INKS) {
        const colour = painted(ink);
        for (const surface of surfaces) {
          expect(
            contrast(colour, surface),
            `${ink} on ${surface.join(",")}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  it.each([false, true])("keeps state out of the accent violet (dark=%s)", (dark) => {
    using _theme = themed(dark);
    const accent = painted("--accent");
    const accentInk = painted("--accent-ink");
    for (const variable of [...STATUS_INKS, ...STATUS_HUES]) {
      expect(painted(variable), `${variable} borrows the accent`).not.toEqual(accent);
      expect(painted(variable), `${variable} borrows the accent ink`).not.toEqual(accentInk);
    }
  });

  it("compiles the status utility classes the chips and pips paint", () => {
    const probe = document.createElement("span");
    probe.className = "bg-status-back/15 text-status-back-ink";
    const reference = document.createElement("span");
    reference.style.color = "var(--status-back-ink)";
    document.body.append(probe, reference);
    expect(getComputedStyle(probe).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(probe).color).toBe(getComputedStyle(reference).color);
    probe.remove();
    reference.remove();
  });

  it.each([false, true])("gives every status family a distinct hue (dark=%s)", (dark) => {
    using _theme = themed(dark);
    const hues = STATUS_HUES.map(painted);
    for (let index = 0; index < hues.length; index += 1) {
      for (let other = index + 1; other < hues.length; other += 1) {
        expect(hues[index], `${STATUS_HUES[index]} and ${STATUS_HUES[other]}`).not.toEqual(
          hues[other],
        );
      }
    }
  });
});
