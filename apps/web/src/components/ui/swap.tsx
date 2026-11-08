import { useEffect, useState, type ReactNode } from "react";

import { useReducedMotion } from "~/hooks/useReducedMotion";
import { cn } from "~/lib/utils";
import { MOTION_ROLE_MS } from "~/motion/registry";

export interface SwapProps {
  /** Identity of the content. A new value replaces the current layer in place. */
  readonly swapKey: string | number;
  /** Layout classes for the positioning container. */
  readonly className?: string;
  /** Layout classes repeated on each content layer, so both fill the container alike. */
  readonly contentClassName?: string;
  /** Layout classes for the animated wrapper inside each layer, for content that must fill it. */
  readonly innerClassName?: string;
  readonly children: ReactNode;
}

interface SwapLayer {
  readonly key: string | number;
  readonly node: ReactNode;
}

interface SwapState {
  readonly active: 0 | 1;
  readonly exiting: 0 | 1 | null;
  readonly layers: readonly [SwapLayer | null, SwapLayer | null];
}

const ENTER_CLASS =
  "transition-[opacity,translate] duration-(--motion-swap-in) ease-standard starting:translate-y-(--motion-swap-rise) starting:opacity-0";
const EXIT_CLASS =
  "transition-[opacity,translate] duration-(--motion-swap-out) ease-exit -translate-y-(--motion-swap-rise) opacity-0";

/**
 * Replaces keyed content in place: the next layer fades in from a small rise while the
 * previous one, pulled out of flow, fades out. Only transform and opacity animate, so
 * the container never transitions a layout property.
 */
export function Swap({
  swapKey,
  className,
  contentClassName,
  innerClassName,
  children,
}: SwapProps) {
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState<SwapState>(() => ({
    active: 0,
    exiting: null,
    layers: [{ key: swapKey, node: children }, null],
  }));

  const activeLayer = state.layers[state.active];
  if (activeLayer?.key !== swapKey) {
    const nextActive = state.active === 0 ? 1 : 0;
    const layers: [SwapLayer | null, SwapLayer | null] = [...state.layers];
    layers[nextActive] = { key: swapKey, node: children };
    if (reducedMotion) layers[state.active] = null;
    setState({
      active: nextActive,
      exiting: reducedMotion ? null : state.active,
      layers,
    });
  }

  const exiting = state.exiting;
  // The exit timer is outside React; it removes the outgoing layer when its role duration ends.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the layer tree in step with a running timer
  useEffect(() => {
    if (exiting === null) return;
    const timeout = window.setTimeout(() => {
      setState((current) => {
        if (current.exiting !== exiting) return current;
        const layers: [SwapLayer | null, SwapLayer | null] = [...current.layers];
        layers[exiting] = null;
        return { active: current.active, exiting: null, layers };
      });
    }, MOTION_ROLE_MS["swap-out"]);
    return () => window.clearTimeout(timeout);
  }, [exiting]);

  const renderLayer = (index: 0 | 1) => {
    const active = state.active === index;
    const isExiting = state.exiting === index;
    if (!active && !isExiting) return null;
    const layer = state.layers[index];
    return (
      <div
        key={index === 0 ? "a" : "b"}
        data-slot="swap-layer"
        data-state={active ? "active" : "exiting"}
        aria-hidden={isExiting || undefined}
        inert={isExiting || undefined}
        className={cn(
          contentClassName,
          isExiting && "pointer-events-none absolute inset-x-0 top-0",
        )}
      >
        <div
          key={active ? swapKey : layer?.key}
          className={cn(active ? ENTER_CLASS : EXIT_CLASS, innerClassName)}
        >
          {active ? children : layer?.node}
        </div>
      </div>
    );
  };

  return (
    <div data-slot="swap" className={cn("relative", className)}>
      {renderLayer(0)}
      {renderLayer(1)}
    </div>
  );
}
