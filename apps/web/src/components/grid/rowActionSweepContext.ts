import { createContext } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { SweepAction } from "../../grid/rowActionSweep";

/** Starts a press-and-sweep from a row's action button; null where rows cannot sweep. */
export type RowActionSweep = (
  event: ReactPointerEvent<HTMLElement>,
  action: SweepAction,
  threadKey: string,
) => void;

export const RowActionSweepContext = createContext<RowActionSweep | null>(null);
