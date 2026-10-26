# Voices, engines and licences

Phononspeak can call four speech engines. None of them is bundled with this plugin, and the licences
differ in ways that change what you may do with the audio. This page lists, per engine, the licence
that governs it, the attribution line to copy, what may be shipped with a build, and what you must
download yourself.

The plugin itself is MIT ([LICENSE](../LICENSE)); the engines are not, and their terms travel with them.

## Summary

| Engine | Code / binary licence | Weights or voice licence | Commercial use | Bundled with the plugin |
|---|---|---|---|---|
| Supertonic 3 | MIT | OpenRAIL-M | Yes, with obligations | No — downloaded on first use |
| Piper | GPL-3.0-or-later (MIT up to 1.2.0) | voices: CC0 or CC-BY-4.0 | Yes, if the voice allows it | No — installed separately |
| Pocket TTS Czech | CC-BY-4.0 (model) | CC-BY-4.0 incl. training data | Yes, with attribution | No — downloaded on first use |
| macOS `say` | Apple system software | same | **No** — personal, non-commercial only | No — part of macOS |

## Supertonic 3 (default)

**What it is.** Supertone's `supertonic-3`: 99M parameters, ONNX runtime, 31 languages including Czech,
ten voice styles (`F1`–`F5`, `M1`–`M5`). Roughly 380 MB of weights and a ~160 MB Python virtualenv.
The licence the plugin itself shows in its engine card is `https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE`.

**Licence split.** The code is MIT. The weights are under **OpenRAIL-M**, which is not an OSI-approved
open-source licence: it permits commercial use but attaches use-based restrictions that must travel
with the weights.

**OpenRAIL-M obligations, in practice:**

1. **Ship the licence and the use restrictions.** Anyone who receives the weights — or a derivative of
   them — must get the OpenRAIL-M text together with its use restrictions.
2. **Pass the restrictions downstream.** If you fine-tune, convert, quantise or otherwise redistribute
   the weights, the recipient inherits the same restrictions; you cannot relicense them as unrestricted.
3. **Mark modified files.** If this project (or you) changes any weight file, the change must be
   identified as modified.
4. **No endorsement.** Do not present the output as endorsed by Supertone, and do not use their marks to
   promote a derivative.

The plugin does not redistribute the weights: it downloads them on first use, into `~/.cache/supertonic3`.
That keeps the obligation where it belongs — with whoever distributes a copy.

**Attribution line to copy:**

```
Speech synthesis uses Supertonic 3 by Supertone Inc.
Model code: MIT License. Model weights: OpenRAIL-M License, including its use restrictions.
Modified weight files, if any, are marked as modified.
```

## Piper

**What it is.** The Piper engine plus a Czech voice. 60–80 MB per voice, no Python virtualenv, about
17× realtime on the development machine. Available Czech voices: `jirka` (low and medium) and
`kasandra` (medium). The plugin's engine card points at the GPL fork's licence text,
`https://github.com/OHF-Voice/piper1-gpl/blob/main/LICENSE.md`.

The plugin never downloads the engine binary — the licence and the bring-your-own-binary model both
argue against it. It spawns `piper` from `PATH`, or the path in `PHONONSPEAK_PIPER`.

**The GPL boundary.** `piper-tts` 1.3 and later is **GPL-3.0-or-later**; 1.2.0 and earlier were MIT.
The engine runs as a **separate process** spawned from `lib/engines.js`. It is never linked into this
program, never copied into `lib/`, and never distributed in this repository or its package. That is
why the plugin can stay MIT while calling a GPL program: two independent programs, one invoking the
other as a subprocess, is aggregation, not a combined work.

What would change that, and must not be done: vendoring Piper sources or a prebuilt binary into the
package, linking it as a library, or copying its code into `lib/`. If you fork this plugin and ship
Piper inside it, the whole distribution has to satisfy the GPL — including source availability for
the engine.

**Voice licences.** Each Piper voice states its own licence; the Czech voices here are CC0 or
CC-BY-4.0. CC-BY-4.0 requires attribution, so credit the voice's publisher when you redistribute audio
made with it. Some voices are published only for non-commercial use — check the voice card before
using it commercially, because the engine licence says nothing about the voice.

**Attribution line to copy:**

```
Speech synthesis uses Piper (https://github.com/rhasspy/piper),
licensed under the GNU General Public License v3.0 or later.
Piper is used as a separate program and is not distributed with this plugin.
Czech voice models are licensed under CC0 or CC BY 4.0 as stated by their publisher.
```

## Pocket TTS Czech

**What it is and what you may do with it.** `vvolhejn/pocket-tts-czech`, 438 MB, six layers, 24 kHz
mono output, cloning from a wav, faster than realtime on CPU. Licensed **CC-BY-4.0** for the model
**and** its training data.

**CC-BY-4.0 obligations:**

1. **Give appropriate credit** — to the model author and to the corpus authors (ÚFAL / ParCzech).
2. **Link to the licence** and indicate whether changes were made.
3. **No additional restrictions** — you may not add terms that legally prevent others from doing what
   the licence allows.

**Training data.** 976 hours of Czech parliamentary speech (ParCzech4Speech), 524 speakers. The licence
covers the dataset; it does not make the recorded speakers endorsers of anything, and it does not grant
personality rights. See "Cloning consent" below.

**Attribution line to copy:**

```
Cloned-voice synthesis uses the Pocket TTS Czech model (vvolhejn/pocket-tts-czech),
licensed under Creative Commons Attribution 4.0 International (CC BY 4.0).
The model was trained on ParCzech4Speech (976 hours of Czech parliamentary speech),
published by the Institute of Formal and Applied Linguistics (ÚFAL),
Faculty of Mathematics and Physics, Charles University.
Voice samples are used with the permission of their owners.
```

## macOS `say`

**What it is.** The operating system's own speech synthesis, with Czech voices (Zuzana and Zuzana
Premium). 0 MB, instant, and the best Czech text normalisation of the four engines — and the one with
the strictest licence.

**The restriction.** The macOS Software License Agreement, section 2.F ("Voices; Live Captions"),
permits the system voices only for your own original content, and only for **personal, non-commercial
use**. Publication and any commercial context are outside that permission. Apple's Personal Voice
falls under the same restriction.

**How the plugin treats it.** `commercialMode` defaults to `true` and `allowPersonalVoice` to `false`.
In that state `auto` skips `say`, and an explicit `engine=say` request is refused as well — the tool
returns an error and the queue records it, so the gate is a refusal, not a warning label. A job with no
other usable engine fails with a message instead of falling back to `say`; the engine card carries the
licence warning and the system prompt tells the model not to use it. Turning `allowPersonalVoice` on is
an explicit statement by the user that the output is personal and non-commercial. The plugin cannot
grant that permission; it can only refuse to assume it.

**Attribution.** No attribution is required, but do not describe `say` as licensed for commercial use.

## Cloning consent

CC-BY-4.0 lets you use the model and its outputs commercially. It does **not** give you a person's
voice. The rule this plugin states in its UI, and refuses to bypass:

- Clone **your own voice**, or a voice for which you hold **written consent** from the speaker.
- The six reference wavs shipped with the model are recordings of real Czech members of parliament, and
  the host never selects one by itself: Pocket needs a voice the user registered, otherwise it is skipped
  by `auto` and refused for an explicit request.
  Personality rights still apply; a model licence is not a release form.
- The plugin stores the voice's display name, the absolute path to your wav and a `rightsConfirmed`
  flag. It never copies the audio, and deleting the voice leaves your file untouched.
- The host rejects an `addVoice` request without the confirmation (HTTP 400), so the checkbox cannot be
  skipped by a different client.

What a clone will and will not give you: recognisable timbre, no transfer of prosody or emotion. It
sounds like someone else with a similar voice.

## What is not included, and why

These engines were evaluated and deliberately excluded because their licences do not permit commercial
use:

| Engine | Reason |
|---|---|
| XTTS v2 (Coqui) | CPML forbids commercial use of the model **and its outputs**, and Coqui — the company that could have sold a commercial licence — is defunct, so no licence can be bought. |
| ZipVoice-CZ | Non-commercial research licence. |
| OmniVoice | Non-commercial licence. |
| Higgs | Licence does not permit commercial use. |
| Fish s2-pro | Non-commercial licence. |
| MMS (Meta) | Non-commercial licence. |

The list is a decision, not an accident: a plugin that promises "local and commercially usable Czech
speech" cannot quietly fall back to a model that forbids commercial output.

## What may be shipped with a build

| Item | May ship | Why |
|---|---|---|
| `lib/*.js`, `locale/*`, `docs/`, `README*`, `CHANGELOG.md` | Yes | MIT, this repository's own work |
| This plugin's SVG icon | Yes | own work |
| Supertonic weights | No | OpenRAIL-M restricts redistribution conditions and adds obligations; the plugin downloads them instead |
| Piper binary or sources | No | GPL; keep the arm's-length process boundary |
| Piper voices | Only with their own licence and attribution | CC0 or CC-BY-4.0 per voice |
| Pocket TTS Czech weights | No | 438 MB, and CC-BY-4.0 attribution must follow the copy; the plugin downloads them |
| Voice samples of real people | No | Personality rights, independent of any model licence |
| Audio rendered by `say` | No | Personal, non-commercial use only |

## Adding another engine

Before an adapter is written, answer these four questions:

1. May the output be used commercially? If not, the engine belongs behind an explicit opt-in like
   `allowPersonalVoice`, or not in the project at all.
2. May the weights be redistributed, and under what obligations (notice, use restrictions, marking
   modifications)?
3. Does the licence cover the training data, or only the weights?
4. Can it run as a separate process, so a copyleft engine does not reach into `lib/`?

If the answer to (1) is no and the answer to (2) is "no redistribution", the engine can still be
supported — as a download the user performs, never as a bundled asset.
