# Dictation

Dictation turns speech into text for the composer, citation comments, diff and file comments,
pull request comments, replies and review summaries, and the desktop browser's annotation
editor. The transcript lands in the draft for review; only sending the draft sends anything to
an agent.

## Choose where audio goes

Nothing is recorded or sent until you choose how to transcribe. Open Settings ▸ Voice and set
**Transcribe with**:

- **An environment**, such as **Work VM**. Audio recorded on this device goes to that environment
  over its authenticated connection, is transcribed there by its bundled speech engine, and is
  discarded.
- **A cloud provider**, listed as **OpenAI via Work VM**, **Grok Voice Transcribe via Work VM** or
  **OpenRouter via Work VM**. After you stop, that environment sends the finished recording to the
  provider with your API key and returns the text. Houston has no account with any provider; the
  key and the usage bill are yours.
- **Off**, which turns voice input off on this device.

Choosing a provider opens a dialog that says what is sent and asks for the provider's API key.
**Save and enable** opts in only this device, and only after the key is saved. The key is
stored in the environment's secret store (or read from a secret provider you configure) and is
never shown again; anyone with dictation access to that environment can use it. Another device can
use a saved key, but must make its own choice. A saved key, or a paired device, never opts a device
in. The menu offers no provider on an environment that cannot forward recordings.

For OpenRouter the dialog also asks for an exact transcription model from OpenRouter's
zero-data-retention list. OpenRouter chooses who runs it, and your OpenRouter account may allow
safety retention. Dictation stays off if OpenRouter stops listing the chosen model.

The key button beside the menu opens **Manage**: change the model, replace the key, or remove the
key, which ends access for everyone using it on that environment. Changing only the model never
rewrites the key. Replacing a key keeps dictation enabled.

The choice is saved on this device only, so each computer asks once. Set it back to **Off** at
any time; a recording in progress is discarded. If the chosen environment is offline, dictation
waits for it and never substitutes another environment or provider. If the key is missing or
unreadable, the model is unlisted, or the provider rejects the key or reaches a usage limit,
dictation stops with a message that names the provider; no other provider or model is tried. An
environment running an older version of the voice service is refused by name until it is updated.

## Network use

While **Transcribe with** is Off, dictation sends nothing. Otherwise:

- Each recording is streamed or uploaded to the chosen environment, with the language, the
  dictionary entries and the project name as hints.
- With a cloud provider, the environment makes these calls and no others:
  - `POST https://api.openai.com/v1/audio/transcriptions` for OpenAI, and
    `POST https://api.x.ai/v1/stt` for Grok Voice Transcribe, once per finished recording. Each
    carries the key, the recording as 16 kHz mono WAV, the language, and your dictionary terms
    including the project name as hints.
  - `POST https://openrouter.ai/api/v1/audio/transcriptions`, once per finished recording, with
    the key, the chosen model, the recording and the language, and a request for zero data
    retention. It carries no dictionary terms and no project name.
  - `GET https://openrouter.ai/api/v1/models?output_modalities=transcription&zdr=true`, with no key
    and no audio, when the model list opens and before an OpenRouter upload; the answer is cached
    for ten minutes.
    A request waits up to two minutes. A response over 1 MiB, or a model list over 4 MiB or 500
    models, is refused naming its size and the limit. An API key is refused above 2,048 bytes.
- Each model is downloaded from Hugging Face to the chosen environment the first time you
  download it, at a pinned revision verified by checksum. The silence filter downloads a
  1.2 MB voice activity model the same way.
- Transcript cleanup, when you turn it on, sends text to a provider (see below).

## Set up a model

The first dictation offers to download the recommended English model to the chosen
environment. In Settings ▸ Voice ▸ Transcription, select the languages you dictate in to
compare the models that support all of them. Accuracy shows how often the model got words or
characters wrong in each language; speed is the time to transcribe 30 seconds of audio on a
reference GPU. Choose **All languages** to browse the full catalog. Filtering does not change
your model. The download tooltip shows each model's licence.

Models marked **Live preview** show text while you speak. Other models transcribe long
recordings in chunks at pauses, or when you stop. If a selected model is no longer offered, the
page names it and dictation uses the default model.

**Advanced** chooses GPU or CPU and when an idle model is unloaded. With hardware set to
**Auto**, a recording that fails on the GPU is retried once on the same environment's CPU.

## Dictate

Click the microphone in the composer or editor, or press `Ctrl+Alt+V` (`Cmd+Option+V` on
macOS). Press again, or the check mark, to finish; `Esc` discards the recording and leaves the
draft unchanged. Recordings last up to five minutes. Text is inserted at the cursor or replaces
the selection you had when recording started; the editor is read-only while dictation runs.

Pressing Send, Save, Comment, Reply or Submit review while dictating finishes the recording
and submits once the transcript is inserted. Cancelling the recording also cancels that
submission. The shortcut targets the editor that has focus, or the composer when none does. In
the desktop browser's annotation editor, recording runs in Houston itself; the page you are
annotating never receives the audio. Server-side browser tabs do not offer dictation.

**Dictation shortcut** in Settings ▸ Voice picks how the keybinding behaves: **Auto**
tap-toggles or records while held, **Hold** records only while the keys are down, and
**Toggle** always needs a second press. Change the chord in Settings ▸ Keybindings.

## Improve recognition

- **Language** picks what you speak. **Auto** lets a multilingual model detect it. Models that
  translate offer **Translate to English**.
- **Dictionary** holds names and terms the model should get right, with aliases for
  misspellings it keeps producing. It is saved on this device and accepts accented and
  non-Latin spellings such as `Aplicação`, except Chinese, Japanese and Korean terms.
- **Project dictionary** is saved with a project on its environment, so everyone who dictates
  in that project gets the same spellings. Pick the project at the top of Settings to edit it.
  Project spellings win when they overlap your own. Each recording carries up to 100 entries
  from both; adding past the limit is refused with the current count.
- **Silence filtering** is on by default and skips non-speech audio on the environment before
  transcription. It does not reduce what is sent. With OpenAI and OpenRouter it has no effect,
  because those providers receive the whole recording.
- **Remove filler words** drops hesitation sounds such as "uh" and "hmm" in any language, plus
  language-specific ones for English, German, French, Portuguese and Spanish. Words that are
  also vocabulary, such as "um" in Portuguese, are kept.

## Clean up transcripts with a provider

Transcript cleanup is a separate choice for this device and is off by default. When on, the
finished transcript and up to 1,024 characters each from before, inside and after your
selection are sent to the text generation provider configured on the draft's environment,
which fixes punctuation, numbers and spoken corrections such as "make it 42, sorry, 24".
Audio is never sent to it, whichever way you transcribe. Use the built-in instructions or write your own. Press **Skip**
while cleanup runs to insert the raw transcript; if cleanup fails, the raw transcript is
inserted.

Cleanup uses the environment's text generation model unless you pick a **Cleanup model**.
Set a **Correction cue**, such as "scratch that", if cleanup misses how you correct yourself.

## Test and troubleshoot

**Test microphone** records up to ten seconds and plays it back on this device; the audio is
never transcribed, so silent playback points at the microphone. **Test model** shows a
transcript from the selected model with the same environment, language and dictionary as
dictation, without cleanup. If the selected microphone is missing, choose another or the
system default.
