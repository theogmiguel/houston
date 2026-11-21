import { useSyncExternalStore } from "react";

import { getActiveLocale, subscribeActiveLocale } from "./locale";
import { translate, type Locale, type TranslationParams } from "./translate";

export type Translate = (source: string, params?: TranslationParams) => string;

/** The active locale, following the saved language setting. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeActiveLocale, getActiveLocale, getActiveLocale);
}

/** A `t()` bound to the saved language. */
export function useT(): Translate {
  const locale = useLocale();
  return (source, params) => translate(locale, source, params);
}
