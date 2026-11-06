import type { EnvironmentSpeechModel } from "@houston-app/contracts";
import { CheckIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { languageLabel } from "./SpeechLanguageSelect";

// The most spoken languages first, so the filter opens on the ones most people look for.
const commonLanguages = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "bn",
  "pt",
  "id",
  "ur",
  "ru",
  "de",
  "ja",
  "mr",
  "vi",
  "te",
  "sw",
  "ha",
  "tr",
  "tl",
  "ta",
  "jw",
  "ko",
  "am",
  "th",
  "it",
  "gu",
  "kn",
  "yo",
];

/** Browser languages first, then the most spoken, then the rest by name. */
export function orderSpeechLanguages(languages: readonly string[], preferred: readonly string[]) {
  const order = [...new Set([...preferred, ...commonLanguages])];
  const rank = new Map(order.map((code, index) => [code, index]));
  return languages.toSorted(
    (left, right) =>
      (rank.get(left) ?? order.length) - (rank.get(right) ?? order.length) ||
      languageLabel(left).localeCompare(languageLabel(right)),
  );
}

export function LanguageRow({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={selected ? "secondary" : "ghost"}
      aria-pressed={selected}
      className="shrink-0 justify-between"
      onClick={onClick}
    >
      {label}
      {selected ? <CheckIcon className="shrink-0" /> : null}
    </Button>
  );
}

/** Grade and error rate per chosen language, then speed, then plain facts such as size. */
export function ModelBenchmarks({
  model,
  languages,
  facts,
}: {
  model: EnvironmentSpeechModel;
  languages: readonly string[];
  facts: readonly string[];
}) {
  const data = model.benchmark;
  const visible = !data
    ? []
    : languages.length
      ? languages
      : [model.languages.find((code) => data.accuracy[code]) ?? model.languages[0]].filter(
          (code): code is string => code !== undefined,
        );
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
      {visible.map((code) => {
        const score = data?.accuracy[code];
        return (
          <Text key={code} as="span" variant="caption" tone="muted" tabular>
            {languageLabel(code)}:{" "}
            {score ? (
              <>
                <Text as="strong" variant="caption" weight="medium">
                  {score.grade}
                </Text>{" "}
                ({score.errorPercent}% error)
              </>
            ) : (
              "not benchmarked"
            )}
          </Text>
        );
      })}
      {data ? (
        <Text as="span" variant="caption" tone="muted" tabular>
          Speed:{" "}
          {data.secondsPer30s === null ? (
            "not benchmarked"
          ) : (
            <>
              <Text as="strong" variant="caption" weight="medium">
                {data.secondsPer30s} s
              </Text>{" "}
              / 30 s
            </>
          )}
        </Text>
      ) : null}
      {facts.map((fact) => (
        <Text key={fact} as="span" variant="caption" tone="muted" tabular>
          {fact}
        </Text>
      ))}
    </div>
  );
}
