import { useClientSettings } from "../hooks/useSettings";
import { resolveLocale, translate, type Locale, type TranslationParams } from "./translate";

export type Translate = (source: string, params?: TranslationParams) => string;

/** The active locale, following the saved language setting. */
export function useLocale(): Locale {
  return useClientSettings((settings) => resolveLocale(settings.language));
}

/** A `t()` bound to the saved language. */
export function useT(): Translate {
  const locale = useLocale();
  return (source, params) => translate(locale, source, params);
}
