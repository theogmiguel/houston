import en from "../../../web/src/i18n/catalogues/en.json" with { type: "json" };
import ptBR from "../../../web/src/i18n/catalogues/pt-BR.json" with { type: "json" };

export type DesktopLocale = "en" | "pt-BR";

export function resolveDesktopLocale(language: string | undefined): DesktopLocale {
  return language === "pt-BR" ? "pt-BR" : "en";
}

const catalogues: Readonly<Record<DesktopLocale, Readonly<Record<string, string>>>> = {
  en,
  "pt-BR": ptBR,
};

export function translateDesktop(
  locale: DesktopLocale,
  source: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  const text = catalogues[locale][source] ?? source;
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/gu, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}
