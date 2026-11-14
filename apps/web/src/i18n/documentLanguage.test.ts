import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { __setClientSettingsForTests, persistClientSettingsPatch } from "../hooks/useSettings";
import { startDocumentLanguageSync } from "./documentLanguage";

const noPersist = () => Promise.resolve();

describe("startDocumentLanguageSync", () => {
  beforeEach(() => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  });

  afterEach(() => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  });

  it("marks the document with the active language and follows changes", async () => {
    const target = { documentElement: { lang: "" } };
    const stop = startDocumentLanguageSync(target);
    expect(target.documentElement.lang).toBe("en");

    await persistClientSettingsPatch({ language: "pt-BR" }, noPersist);
    expect(target.documentElement.lang).toBe("pt-BR");

    await persistClientSettingsPatch({ language: "klingon" }, noPersist);
    expect(target.documentElement.lang).toBe("en");
    stop();
  });
});
