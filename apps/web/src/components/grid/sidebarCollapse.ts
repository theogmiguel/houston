import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/** Grid collapse survives a reload, like the shelves' expansion. */
export const COLLAPSED_GRIDS_STORAGE_KEY = "t3code:sidebar:collapsed-grids";

const EMPTY_COLLAPSED_KEYS: ReadonlyArray<string> = [];

export function toggleCollapsedKey(
  keys: ReadonlyArray<string>,
  key: string,
): ReadonlyArray<string> {
  return keys.includes(key) ? keys.filter((candidate) => candidate !== key) : [...keys, key];
}

export function useCollapsedKeys(storageKey: string): {
  readonly collapsed: ReadonlySet<string>;
  readonly toggle: (key: string) => void;
} {
  const [keys, setKeys] = useLocalStorage(
    storageKey,
    EMPTY_COLLAPSED_KEYS,
    Schema.Array(Schema.String),
  );
  return {
    collapsed: new Set(keys),
    toggle: (key) => setKeys((current) => toggleCollapsedKey(current, key)),
  };
}
