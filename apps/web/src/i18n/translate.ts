export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "pt-BR"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export type Catalogue = Readonly<Record<string, string>>;

const tables: Record<Locale, Catalogue> = { en: {}, "pt-BR": {} };

/**
 * Keyed by the English source text, so an untranslated string renders as written and a
 * missing key never shows an identifier. English needs no table at runtime because its
 * text is the key (`catalogues/en.json` lists the keys for the parity tests); the others
 * fill in through `loadCatalogue`, so the boot bundle carries no language it does not show.
 */
export const CATALOGUES: Readonly<Record<Locale, Catalogue>> = tables;

const catalogueLoaders: Partial<Record<Locale, () => Promise<{ readonly default: Catalogue }>>> = {
  "pt-BR": () => import("./catalogues/pt-BR.json"),
};
const catalogueLoads = new Map<Locale, Promise<void>>();

export function isCatalogueLoaded(locale: Locale): boolean {
  return catalogueLoaders[locale] === undefined || Object.keys(tables[locale]).length > 0;
}

/** Fills a locale's table once. A failed load is dropped so the next call tries again. */
export function loadCatalogue(locale: Locale): Promise<void> {
  const loader = catalogueLoaders[locale];
  if (loader === undefined) return Promise.resolve();
  let pending = catalogueLoads.get(locale);
  if (pending === undefined) {
    pending = loader().then(
      (module) => {
        tables[locale] = module.default;
      },
      (error: unknown) => {
        catalogueLoads.delete(locale);
        throw error;
      },
    );
    catalogueLoads.set(locale, pending);
  }
  return pending;
}

/** Each language in its own name, so a user can find theirs from any interface language. */
export const NATIVE_LANGUAGE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  "pt-BR": "Português (Brasil)",
};

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(value);
}

/** Saved setting to active locale; an unknown value renders English instead of failing. */
export function resolveLocale(language: string): Locale {
  return isSupportedLocale(language) ? language : DEFAULT_LOCALE;
}

export type TranslationParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** One pass, so a substituted value that contains `{name}` is not expanded again. */
function interpolate(text: string, params: TranslationParams | undefined): string {
  if (params === undefined) return text;
  return text.replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

/** The translation of `source` in `locale`; English source text when none exists. */
export function translate(locale: string, source: string, params?: TranslationParams): string {
  const catalogue = isSupportedLocale(locale) ? CATALOGUES[locale] : undefined;
  const translated =
    catalogue !== undefined && Object.hasOwn(catalogue, source) ? catalogue[source] : undefined;
  return interpolate(translated ?? source, params);
}
