import { describe, expect, it } from "vite-plus/test";

import { translate } from "~/i18n/translate";

describe("thread action confirmations", () => {
  it("names the archive and delete confirmations in Brazilian Portuguese", () => {
    const t = (source: string, params?: Record<string, string | number>) =>
      translate("pt-BR", source, params);
    expect(t('Delete thread "{title}"?', { title: "Fix the rail" })).toBe(
      'Excluir a thread "Fix the rail"?',
    );
    expect(t('Unpin thread "{title}"?', { title: "Fix the rail" })).toBe(
      'Desafixar a thread "Fix the rail"?',
    );
    expect(t("Delete the worktree too?")).toBe("Excluir a worktree também?");
  });

  it("keeps the English confirmations when the language is English", () => {
    expect(translate("en", 'Delete thread "{title}"?', { title: "Fix the rail" })).toBe(
      'Delete thread "Fix the rail"?',
    );
  });
});
