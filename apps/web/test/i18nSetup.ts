import { loadCatalogue, SUPPORTED_LOCALES } from "../src/i18n/translate";

// Tests render in any supported language synchronously, so every catalogue is loaded first.
await Promise.all(SUPPORTED_LOCALES.map(loadCatalogue));
