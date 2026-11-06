# Dictation

Dictation turns speech into composer text on your own machine.

Click the microphone beside the composer's send button, or press `Ctrl+Alt+V` (`Cmd+Option+V`
on macOS), to start. Press it again to finish, or press `Esc` to discard the recording.
Settings ▸ Voice sets whether the shortcut auto-detects a hold, records only while held, or
records on one press and stops on the next.

The first dictation downloads a speech model from Hugging Face. The Voice settings page lists
every model with its size and language coverage, so you can pick a smaller or more accurate
one before or after the first download. The model is cached under the server state directory
of the transcription environment; it is not bundled with Houston and it is never re-downloaded
unless you remove it.

## Where audio goes

Microphone audio goes only to the selected **transcription environment** — the Houston server
on this machine, or one you configured in Settings ▸ Voice. That server transcribes it
locally with its own bundled speech engine. Audio is not sent to a provider, to Houston, or to
any telemetry service.

If transcript cleanup is enabled, the finished **text** of the transcript (never the audio)
is sent to the text generation provider selected in Settings ▸ Voice for punctuation, filler
words and spoken corrections. Cleanup is off by default, so transcripts stay on the machine.

## Settings

Settings ▸ Voice selects the transcription environment and microphone, downloads and removes
models, sets the language and translation, chooses CPU or GPU acceleration, and sets how long
an idle model stays in memory. It also holds the dictionary for names and technical terms,
the filler-word removal toggle, and the cleanup prompt. The dictionary accepts accented and
non-Latin spellings such as `Aplicação`, except Chinese, Japanese and Korean terms.

Filler-word removal drops hesitation sounds such as "uh" and "hmm" in any language, plus
language-specific ones for English, German, French, Portuguese and Spanish. With the language
set to Auto, only the language-neutral sounds are removed. Words that are also vocabulary,
such as "um" in Portuguese or the laughter "ha", are kept.

Dictation is available where the composer accepts text. A thread whose question requires a
fixed answer does not offer it.
