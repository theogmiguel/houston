import {
  isCatalogueLoaded,
  loadCatalogue,
  resolveLocale,
  translate,
  type Locale,
  type TranslationParams,
} from "./translate";

let activeLocale: Locale = "en";
const listeners = new Set<() => void>();

/** The language every mounted `useT` reads, kept in step with the saved client settings. */
export function getActiveLocale(): Locale {
  return activeLocale;
}

export function setActiveLocale(language: string): void {
  const next = resolveLocale(language);
  if (next === activeLocale) return;
  activeLocale = next;
  notifyListeners();
  // Until its catalogue arrives the text renders in English; arriving re-renders every `useT`.
  if (!isCatalogueLoaded(next)) {
    void loadCatalogue(next).then(
      () => {
        if (activeLocale === next) notifyListeners();
      },
      () => undefined,
    );
  }
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function subscribeActiveLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Translation for callback code that runs outside React, such as context menus and toasts. */
export function translateCurrent(source: string, params?: TranslationParams): string {
  return translate(activeLocale, source, params);
}
