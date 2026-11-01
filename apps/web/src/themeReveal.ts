import { flushSync } from "react-dom";

export const THEME_REVEAL_DURATION_MS = 400;

export interface ThemeRevealOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ThemeRevealSource = Element | ThemeRevealOrigin;

interface ViewTransition {
  readonly ready: Promise<void>;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransition;
};

// Two switches in one gesture (a theme and its half) start two transitions; the
// scoping attribute stays until the last one ends, including a skipped one.
let activeReveals = 0;

function isElement(origin: ThemeRevealSource): origin is Element {
  return "getBoundingClientRect" in origin;
}

export function themeRevealRadius(
  origin: ThemeRevealOrigin,
  viewport: { width: number; height: number },
): number {
  const x = origin.left + origin.width / 2;
  const y = origin.top + origin.height / 2;
  return Math.ceil(Math.hypot(Math.max(x, viewport.width - x), Math.max(y, viewport.height - y)));
}

/** Keyboard and palette switches reveal from the centre of the window. */
export function themeRevealViewportOrigin(): ThemeRevealOrigin {
  if (typeof window === "undefined") return { left: 0, top: 0, width: 0, height: 0 };
  return { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
}

/**
 * Applies a theme change and grows the new snapshot as a circle from `origin`.
 * A null origin, reduced motion, or a missing View Transition API switches in
 * one step; the attribute only scopes the reveal's pseudo-element rules.
 */
export function revealThemeFromClick(
  origin: ThemeRevealSource | null,
  update: () => void,
  duration = THEME_REVEAL_DURATION_MS,
): void {
  if (!origin || typeof document === "undefined" || typeof window === "undefined") {
    update();
    return;
  }

  const viewTransitionDocument = document as ViewTransitionDocument;
  const rect = isElement(origin) ? origin.getBoundingClientRect() : origin;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const startViewTransition = viewTransitionDocument.startViewTransition;

  if (reducedMotion || typeof startViewTransition !== "function") {
    update();
    return;
  }

  const radius = themeRevealRadius(rect, viewport);
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const root = document.documentElement;
  activeReveals += 1;
  root.dataset.themeReveal = "true";
  let cleared = false;
  const clearReveal = () => {
    if (cleared) return;
    cleared = true;
    activeReveals = Math.max(0, activeReveals - 1);
    if (activeReveals === 0) delete root.dataset.themeReveal;
  };

  let transition: ViewTransition;
  try {
    transition = startViewTransition.call(document, () => flushSync(update));
  } catch {
    clearReveal();
    update();
    return;
  }

  void transition.ready
    .then(() => {
      const easing = getComputedStyle(root).getPropertyValue("--ease-drawer").trim();
      let animation: Animation;
      try {
        animation = root.animate(
          [
            { clipPath: `circle(0px at ${x}px ${y}px)` },
            { clipPath: `circle(${radius}px at ${x}px ${y}px)` },
          ],
          {
            duration,
            easing,
            pseudoElement: "::view-transition-new(root)",
          },
        );
      } catch {
        clearReveal();
        return;
      }
      if (animation && typeof animation.finished?.then === "function") {
        void animation.finished.then(clearReveal, clearReveal);
      } else {
        clearReveal();
      }
    })
    .catch(clearReveal);
}
