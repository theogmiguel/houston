import { describe, expect, it } from "vite-plus/test";

import { translate } from "~/i18n/translate";
import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

function state(translateSource: (source: string) => string): ThreadActionMenuState {
  return {
    canOperate: true,
    canFind: true,
    branch: "main",
    projectFilter: null,
    isSettled: false,
    autoSettleEnabled: true,
    tags: [],
    tagSuggestions: [],
    isSnoozed: false,
    canSnoozeNow: true,
    isRegeneratingTitle: false,
    isRunning: false,
    supports: {
      settlement: true,
      autoSettleOptOut: true,
      snooze: true,
      titleRegeneration: true,
    },
    snoozePresets: [],
    translate: translateSource,
  };
}

describe("thread action menu language", () => {
  it("keeps the English labels when the language is English", () => {
    const items = buildThreadActionMenuItems(state((source) => translate("en", source)));
    const labels = items.map((item) => item.label).filter((label) => label !== undefined);
    expect(labels).toContain("Rename thread");
    expect(labels).toContain("Archive thread");
    expect(labels).toContain("Delete");
  });

  it("renders the labels in Brazilian Portuguese", () => {
    const items = buildThreadActionMenuItems(state((source) => translate("pt-BR", source)));
    const labels = items.map((item) => item.label).filter((label) => label !== undefined);
    expect(labels).toContain("Renomear thread");
    expect(labels).toContain("Arquivar thread");
    expect(labels).toContain("Excluir");
    expect(labels).not.toContain("Rename thread");
  });
});
