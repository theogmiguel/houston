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
  "--status-ready-ink",
  "--status-failed-ink",
] as const;

const STATUS_HUES = [
  "--status-running",
  "--status-back",
  "--status-waiting",
  "--status-input",
  "--status-approval",
  "--status-ready",
  "--status-failed",
] as const;

/** Bright glyph steps; the word takes the matching `-ink`. */
const STATUS_GLYPHS = [...STATUS_HUES] as const;

/** The sidebar chrome plane status words sit on beside the canvas. */
function chrome(): Channels {
  return painted("--rail");
}

describe("status colours", () => {
  it("gives approval the colour of input in both themes", () => {
    for (const dark of [false, true]) {
      using _theme = themed(dark);
      expect(painted("--status-approval")).toEqual(painted("--status-input"));
      expect(painted("--status-approval-ink")).toEqual(painted("--status-input-ink"));
    }
  });

  it.each([false, true])("reads every glyph at 3:1 on the canvas (dark=%s)", (dark) => {
    using _theme = themed(dark);
    const canvas = painted("--content");
    for (const glyph of STATUS_GLYPHS) {
      expect(contrast(painted(glyph), canvas), glyph).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([false, true])(
    "reads every status ink at 4.5:1 on the canvas, the raised card and the sidebar chrome (dark=%s)",
    (dark) => {
      using _theme = themed(dark);
      const surfaces = [painted("--content"), painted("--card"), painted("--raised"), chrome()];
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

  it.each([
    [false, "--status-waiting-ink", [71, 85, 105]],
    [true, "--status-running", [100, 160, 255]],
    [true, "--status-waiting", [148, 163, 184]],
    [true, "--status-back", [45, 212, 191]],
    [true, "--status-back-ink", [45, 212, 191]],
    [false, "--status-back-ink", [15, 118, 110]],
    [false, "--status-running", [59, 130, 246]],
    [false, "--status-running-ink", [29, 78, 216]],
  ] as const)(
    "paints running blue, back teal and waiting slate (dark=%s, %s)",
    (dark, variable, rgb) => {
      using _theme = themed(dark);
      expect(painted(variable)).toEqual(rgb);
    },
  );

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
    const families = STATUS_HUES.filter((hue) => hue !== "--status-approval");
    const hues = families.map(painted);
    for (let index = 0; index < hues.length; index += 1) {
      for (let other = index + 1; other < hues.length; other += 1) {
        expect(hues[index], `${families[index]} and ${families[other]}`).not.toEqual(hues[other]);
      }
    }
  });
});
