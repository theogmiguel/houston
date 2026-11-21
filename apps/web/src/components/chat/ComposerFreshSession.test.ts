import { describe, expect, it } from "vite-plus/test";

import { translate } from "~/i18n/translate";
import { freshSessionBannerItem } from "./ComposerFreshSession";

describe("freshSessionBannerItem", () => {
  it("keeps its English copy when the language is English", () => {
    const item = freshSessionBannerItem(
      () => {},
      (source) => translate("en", source),
    );
    expect(item.title).toBe("Your next message starts a fresh session");
    expect(item.dismissLabel).toBe("Keep the current session");
  });

  it("renders its title, description and dismiss label in Brazilian Portuguese", () => {
    const item = freshSessionBannerItem(
      () => {},
      (source) => translate("pt-BR", source),
    );
    expect(item.title).toBe("Sua próxima mensagem inicia uma nova sessão");
    expect(item.description).toBe("O agente não verá as mensagens anteriores desta thread.");
    expect(item.dismissLabel).toBe("Manter a sessão atual");
  });
});
