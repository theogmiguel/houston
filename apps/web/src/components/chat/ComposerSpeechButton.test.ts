import { expect, it } from "vite-plus/test";

import { resolveSpeechPresentation } from "./ComposerSpeechButton";

it("maps voice input phases to composer actions", () => {
  expect(
    resolveSpeechPresentation({ phase: "idle", error: null, errorAction: null }, null),
  ).toMatchObject({ status: null, showsConfirm: false });
  expect(
    resolveSpeechPresentation({ phase: "preparing", error: null, errorAction: null }, null),
  ).toMatchObject({
    status: "Preparing",
    confirmEnabled: false,
  });
  expect(
    resolveSpeechPresentation({ phase: "recording", error: null, errorAction: null }, null),
  ).toMatchObject({
    status: "Recording",
    confirmEnabled: true,
  });
  expect(
    resolveSpeechPresentation({ phase: "transcribing", error: null, errorAction: null }, null),
  ).toMatchObject({
    status: "Transcribing",
    confirmEnabled: false,
  });
  expect(
    resolveSpeechPresentation({ phase: "post-processing", error: null, errorAction: null }, null),
  ).toMatchObject({
    status: "Post-processing",
    confirmEnabled: false,
  });
  expect(
    resolveSpeechPresentation(
      { phase: "error", error: "No speech was detected.", errorAction: "retry" },
      null,
    ),
  ).toMatchObject({ status: "No speech was detected.", showsConfirm: false });
});

it("shows model download progress while preparing", () => {
  expect(
    resolveSpeechPresentation(
      { phase: "preparing", error: null, errorAction: null },
      { downloaded: 24, total: 48 },
    ).status,
  ).toBe("Downloading speech model 50%");
});
