# Dictation

Dictation lets you speak into a pane instead of typing. Configure its engine, microphone
and activation key in **Settings ▸ Dictation**.

## Engines and network use

Dictation has two engines, and they differ in exactly this:

- **Local (whisper.cpp, offline)** — audio never leaves your machine. Transcription
  runs against a downloaded model file on your own disk.
- **Cloud (Groq whisper-large-v3)** — your recorded audio is sent to Groq's API for
  transcription.

Linux supports both engines. On Windows, use Groq: the local Whisper engine is not
available, and selecting it reports that platform limit.

Paired phones and other devices can also dictate through Houston when you enable
**Settings ▸ Remote access ▸ Dictation ▸ Allow dictation from paired devices**. They use
this computer's selected engine and need trusted HTTPS for microphone access; see
[Remote access](remote-access.md#dictate-instead-of-typing).

Desktop dictation records nothing and never opens this computer's microphone while it
is off. Once enabled, it follows the activation and microphone settings below. The
paired-device setting controls uploaded recordings independently of desktop dictation.

## Choose a local model

In **Settings → Dictation**, choose Local, download or reuse a model, then select it.
Download, selection and deletion are separate actions. The active model and Houston's
model disk usage remain visible. Deleting the active model leaves **No local model
selected**; select another installed model to resume. Houston never downloads a replacement
automatically. Windows lists the catalogue but refuses local selection, downloads and
reuse because the local engine is unavailable.

All models are multilingual. Tiny and Base suit constrained machines; Small is a middle
option. Medium Q5_0 and Large v3 Turbo Q5_0 use quantized weights. Guidance uses physical
cores and total RAM when available and never blocks selection. Memory figures are approximate
working headroom, not measured load requirements. Builds and Auto-detect can increase latency.
Load failures name the model, suggested headroom and available memory when known.

| Model | Download bytes | Approximate disk size |
|---|---:|---:|
| Tiny | 77,691,713 | 74 MiB |
| Base | 147,951,465 | 141 MiB |
| Small | 487,601,967 | 465 MiB |
| Medium Q5_0 | 539,212,467 | 514 MiB |
| Large v3 Turbo Q5_0 | 574,041,195 | 547 MiB |

Explicit downloads contact Hugging Face and its download hosts. They transmit HTTP
connection/request metadata, including the requested model, but no microphone audio.
Houston fetches the corresponding `ggml-*.bin` from the
[upstream model repository](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1),
pinned to that revision, and checks the exact byte count and SHA-256 before installation.

Each model has one active download or reuse operation. Deletion is refused until it
finishes. Failed or interrupted downloads remove partial files and can be retried.
Downloads stop after 30 seconds without response headers or new body bytes, or after
30 minutes overall. After three consecutive download failures, retries pause for five
minutes, including across daemon restarts.

## Reuse installed models

Request a local scan in **Settings → Dictation** for Handy's models directory,
`~/.cache/huggingface/hub`, and other Houston channels' `models/` directories. On Linux,
Handy's directory is `~/.local/share/com.pais.handy/models`; Windows also checks
`com.pais.handy/models` under roaming and local AppData. Scans run only on request,
make no network requests, and stop after 4096 entries, 64 results, depth six, 4 GiB of candidate
bytes hashed, or 30 seconds. A limit produces a visible partial-results notice.

SHA-256 identifies a reusable model, regardless of filename. Choose a link, a copy
into this channel, or a fresh download. Houston verifies reuse again before saving it.
Links depend on the external file remaining present and unchanged; linked bytes are
verified before loading the engine. Removing a linked model removes only Houston's reference
and frees no external disk space. Copies occupy Houston disk space and can be deleted
independently. Houston never writes to, moves or deletes another application's or
channel's model files. Parakeet files are listed as unsupported by the local Whisper
engine and cannot be selected or loaded.

## The API key, and where it is stored

The cloud engine needs a Groq API key, entered in its own row in this settings section.
The key is written to the OS keychain, never to Houston's database and never to its
logs — the same rule Houston applies to every secret it holds. If the keychain itself
can't be reached (locked or missing login keyring, common on some Linux setups), Houston
reports that failure loudly rather than silently treating it as "no key stored", since
those are different problems that call for different fixes.

## Activation: push-to-talk vs toggle

Two activation modes, both under Activation:

- **Hold to talk** — recording runs only while the dictation key is held down.
- **Toggle on / off** — one press starts recording, another press stops it. Because a
  toggle can be left running, a toggled utterance is capped at 5 minutes.

## The dictation key, microphone, and input device

The key that activates dictation is rebindable from the Dictation key row, which opens
Shortcuts rather than duplicating a picker here. Microphone policy controls when the
input stream itself opens: held open for as long as dictation is enabled (faster start,
no clipped first syllable, but the stream sits open until you turn dictation off), or
opened fresh on every keypress (nothing held open between utterances, at the cost of a
slower start that can clip the first syllable). Input device lets you pin a specific
enumerated microphone instead of the system default; an unplugged device is shown as
unavailable rather than silently substituted.

## Spoken language, insertion, and vocabulary

Spoken language biases what the engine expects to hear — it does not translate the
output. It starts as Portuguese; change it to another of the listed languages (English,
Spanish, French, German, Italian, Japanese, Chinese) or to Auto-detect. On the local engine,
Auto-detect adds a detection pass to every dictation, so a set language is noticeably
faster and more confident on short utterances.

Insertion controls what happens to the transcribed text: Direct pastes it straight into
the focused terminal's prompt (Enter is still yours to press), or Confirm first, which
waits for you to approve the text before it is inserted.

Vocabulary is a free-text, comma-separated list of product names or jargon the model
would otherwise mishear — it biases the first-pass transcription toward the words you
list, rather than correcting them after the fact. It starts empty on a fresh install;
nothing is assumed on your behalf.
