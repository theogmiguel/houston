# Dictation

Dictation lets you speak into a pane instead of typing. In Settings, this section is
labelled **Dictation** even though its internal id is `voice` — if you're searching
settings source or exported config for it, look for `voice`.

## The one fact that matters most: what leaves your machine

Dictation has two engines, and they differ in exactly this:

- **Local (whisper.cpp, offline)** — audio never leaves your machine. Transcription
  runs against a downloaded model file on your own disk.
- **Cloud (Groq whisper-large-v3)** — your recorded audio is sent to Groq's API for
  transcription. Cloud is described as better at Brazilian Portuguese, but that quality
  trade comes with sending audio off the machine.

Nothing is recorded and no microphone is opened while dictation is off, for either
engine — the mic only opens according to the activation and microphone settings below,
and only once dictation is turned on.

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
output. Leave it on auto-detect, or pin one of a short list of languages (Portuguese,
English, Spanish, French, German, Italian, Japanese, Chinese) if you dictate mostly in
one language and want faster, more confident recognition on short utterances.

Insertion controls what happens to the transcribed text: Direct pastes it straight into
the focused terminal's prompt (Enter is still yours to press), or Confirm first, which
waits for you to approve the text before it is inserted.

Vocabulary is a free-text, comma-separated list of product names or jargon the model
would otherwise mishear — it biases the first-pass transcription toward the words you
list, rather than correcting them after the fact. It starts empty on a fresh install;
nothing is assumed on your behalf.
