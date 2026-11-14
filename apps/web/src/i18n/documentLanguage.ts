import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { resolveLocale } from "./translate";

/** Keeps `<html lang>` on the active language so screen readers and hyphenation follow it. */
export function startDocumentLanguageSync(
  target: { readonly documentElement: { lang: string } } = document,
): () => void {
  const apply = () => {
    target.documentElement.lang = resolveLocale(getClientSettings().language);
  };
  apply();
  return subscribeClientSettings(apply);
}
