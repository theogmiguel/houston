import { describe, expect, it } from "vite-plus/test";

import { formatModelPickerTraits, resolveModelPickerTraits } from "./modelPickerTraits";

const contextWindowDescriptor = {
  id: "contextWindow",
  label: "Context Window",
  type: "select" as const,
  options: [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M", isDefault: true },
  ],
};

const effortDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  currentValue: "high",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
};

describe("resolveModelPickerTraits", () => {
  it("reads the context size and the current effort the model declares", () => {
    expect(
      resolveModelPickerTraits({ optionDescriptors: [effortDescriptor, contextWindowDescriptor] }),
    ).toEqual({ contextWindow: "1M", effort: "High" });
  });

  it("falls back to the descriptor's default choice when none is selected yet", () => {
    const { currentValue: _currentValue, ...withoutCurrent } = effortDescriptor;
    expect(
      resolveModelPickerTraits({
        optionDescriptors: [
          {
            ...withoutCurrent,
            options: effortDescriptor.options.map((option) =>
              option.id === "high" ? { ...option, isDefault: true } : option,
            ),
          },
        ],
      }).effort,
    ).toBe("High");
  });

  it("reports nothing for a model that declares no context or effort", () => {
    expect(resolveModelPickerTraits(null)).toEqual({ contextWindow: null, effort: null });
    expect(resolveModelPickerTraits({ optionDescriptors: [] })).toEqual({
      contextWindow: null,
      effort: null,
    });
  });

  it("uses the catalog token count when the model has no selectable context descriptor", () => {
    expect(
      resolveModelPickerTraits({
        optionDescriptors: [effortDescriptor],
        contextWindowTokens: 1_000_000,
      }),
    ).toEqual({ contextWindow: "1M", effort: "High" });
  });

  it("ignores a choice with no label to show", () => {
    expect(
      resolveModelPickerTraits({
        optionDescriptors: [{ ...contextWindowDescriptor, options: [{ id: "1m", label: " " }] }],
      }).contextWindow,
    ).toBeNull();
  });
});

describe("formatModelPickerTraits", () => {
  it("joins the labels a model carries, and omits the ones it does not", () => {
    expect(formatModelPickerTraits({ contextWindow: "200k", effort: "High" })).toBe("200k · High");
    expect(formatModelPickerTraits({ contextWindow: null, effort: "High" })).toBe("High");
    expect(formatModelPickerTraits({ contextWindow: "1M", effort: null })).toBe("1M");
    expect(formatModelPickerTraits({ contextWindow: null, effort: null })).toBeNull();
  });
});
