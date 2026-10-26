# dsh-phononspeak

> **Language:** [English](README.md) · [Česky](README.cs.md)

A local, Czech-first voice channel for a DeepSeek Harness agent. The agent can read a short summary
of its answer aloud, and it can call you back to the computer when it needs a decision — with a spoken
sentence, a macOS notification and a banner with "Jsem tady". Speech is synthesised on your machine by
one of four engines, queued with priorities, stoppable, and configured from its own Settings page
inside Harness. No cloud TTS, no API key, no upload of the text.

## Why

An agent that works for minutes at a time is a bad thing to stare at. This plugin exists for two
moments, and nothing else:

| The job | What happens | What it buys you |
|---|---|---|
| **Read the answer aloud** | The model calls `dsh_phononspeak action=summary` with a 1–3 sentence Czech summary; the plugin speaks it | You keep your hands on the work and still hear the result |
| **Call you to the computer** | The agent needs approval or an answer → a short spoken line, a macOS notification, a banner with "Jsem tady" | You do not have to watch the screen, and you do not miss the question |

Everything else is deliberately absent: the plugin does not narrate reasoning, does not read code,
URLs or long lists, and stays silent until it has something worth saying.

## Features

- **Summary reading** — one tool call, one short Czech paragraph. Optionally after every answer
  (`autoSummary`), which also switches on the matching instruction in the system prompt.
- **Written to be spoken** — before synthesis, Markdown and code fences are removed (a removed block is
  announced, not silently skipped), URLs and file paths become words, emoji go away, numbers, dates,
  money and units become Czech numerals with the right gender, dotted Czech abbreviations are expanded,
  and English terms are transliterated. The result is split into sentences of at most 220 characters.
- **Attention calls** — a spoken line, a macOS notification (`osascript`) and an in-UI banner with
  "Jsem tady". Optionally repeated every 15, 30 or 60 seconds until you acknowledge it.
- **A real queue** — attention > question > summary > manual > test. Nothing overlaps; two
  announcements in the same second no longer talk over each other.
- **A real stop** — `action=stop` aborts the running synthesis, kills the player process, clears the
  queue and the repeat timer. Jobs from before the stop are discarded, not resumed.
- **Four engines, licence included** — Supertonic 3 by default, then Piper, Pocket TTS Czech and
  macOS `say`. Each engine carries its licence into the UI, and `say` is kept out of the automatic
  chain outside personal, non-commercial use.
- **Cloned voices (opt-in)** — Pocket TTS Czech clones from a wav of the target voice; the UI asks
  for an explicit rights confirmation before it stores the path.
- **Everything local** — the text never leaves the machine. Audio is served from the Harness origin
  over a Range-capable URL, so the page can pause and seek it.
- **Its own UI** — a Settings page named Phononspeak, a floating mini player, a dedicated tool card,
  and cloned-voice management.

## Install

The plugin is installed as a bundle through the `plugin_manager` tool. A bundle install adds one
host row (`cordis.patch.yml` → `phononspeak`); the Web half is discovered from `package.json`
(`dsh.client`).

**From a local checkout** (development):

```
plugin_manager action="install_bundle" target="/absolute/path/to/dsh-phononspeak"
```

The target must be an **absolute** path. A relative path is refused.

**From Git**, pinned to a commit:

```
plugin_manager action="install_bundle" target="git+https://github.com/meliodascz89/dsh-phononspeak.git#<40-hex-commit>"
```

Use the full 40-character commit SHA. The plugin repository is
`https://github.com/meliodascz89/dsh-phononspeak`.

**From the plugin market**: the catalogue is a format-1 `index.json` served from GitHub Pages of the
same repository. An entry has a `git` source pinned to a commit SHA (an npm source is also
supported); `file:` sources and branch names cannot be expressed in the index, and the index URL
must be final, because a redirect breaks the fetch.

A bundled install becomes active in the running profile. If the Web half was installed for the first
time, reload the Harness window so the client module is loaded.

### Requirements

| Requirement | Why |
|---|---|
| DeepSeek Harness with `@deepseek-ai/dsh-tools >=0.1.1-rc.2 <0.3.0` | The peer range this package declares. |
| Node.js >= 22 | `engines.node` in `package.json`. |
| macOS | For `say`, `afplay` and `osascript`. On Linux and Windows only the in-page player and the non-Apple engines work. |
| Python 3.10 or newer with `venv` | Only for Supertonic and Pocket TTS Czech. Piper and `say` need no Python. The interpreter is discovered and its version verified before a virtualenv is created, because a `python3` shim that answers 3.8 builds half a dependency tree and then fails. |

Two packaging details matter when something does not load:

- The peer range is deliberately open. A Harness loader silently skips a plugin whose peer range is
  not satisfied — the `^0.1.0-rc.6` ranges of the older `dsh-agent-voice` and `dsh-voice-studio` are
  an example: they do not match a 0.2.x runtime, so those plugins never start and nothing is logged.
- The package has no `prepare` or `install` lifecycle script. pnpm runs build scripts for Git
  dependencies only after an explicit approval, so the package ships prebuilt `lib/*.js`.

## First run

The default engine is `auto`, which walks **supertonic → piper → pocket → say**. Only engines that
are actually present are used, and `say` is refused whenever `commercialMode` is on and
`allowPersonalVoice` is off — including an explicit `engine=say` request.

When no engine in the chain is usable and `autoProvision` is on (the default), the host provisions
Supertonic in the background: a Python virtualenv plus the model, about **0.5 GB** of download. The
Settings page and `GET /dsh-phononspeak/setup` show progress; the host tries at most once an hour, so
an offline machine is not hammered.

Without network access the plugin simply uses what is already installed (a Piper binary and voices,
or `say` on macOS) and reports why each missing engine is unavailable instead of failing a job.

Check the result:

```
dsh_phononspeak action=status
```

## Usage

### The tool

One model tool, `dsh_phononspeak`.

| Action | What it does |
|---|---|
| `summary` | Speak a 1–3 sentence Czech summary of the answer. The intended use of the plugin. |
| `attention` | Call the user: speaks the line, shows a notification and a banner, optionally repeats until acknowledged. |
| `speak` | Say any other text deliberately. |
| `stop` | Abort synthesis and playback, clear the queue and the repeat timer. |
| `status` | Current configuration, engine availability, queue length, what is playing. |
| `voices` | The flat voice list across available engines, plus engine records. |
| `install` | Provision an engine (venv, model download). Returns immediately; progress is polled. |
| `ack` | Acknowledge the pending attention call and stop its repetition. |

Parameters: `action` (required), `text`, `voice`, `engine`. The tool description spells out the
allowed action names, because the tool DSL has no `enum` type.

The result is JSON:

```json
{
  "ok": true,
  "kind": "summary",
  "id": "ps-1761480000000-a1b2c3",
  "engine": "auto",
  "voice": "M1",
  "segments": 2,
  "shortened": false,
  "text": "Přepis je hotový a titulky jsou uložené.",
  "output": "browser"
}
```

`segments` is the number of sentences the job was split into, `text` is the normalised (and possibly
shortened) text that was actually queued, and `shortened` says whether the `maxChars` cap cut it.
`engine` and `voice` echo the configured setting at enqueue time — the engine that actually spoke is
reported as `lastEngine` in `GET /dsh-phononspeak/state`.

Examples:

```
dsh_phononspeak action=summary text="Přepis je hotový. Našel jsem tři mluvčí a uložil titulky."
dsh_phononspeak action=attention text="Potřebuji od tebe schválení mazání souborů."
dsh_phononspeak action=speak text="Zkouška hlasu." engine=piper
dsh_phononspeak action=stop
```

### What the model is told

A system-prompt section (`phononspeak`, order 410) is injected only while the feature is enabled, so a
silent plugin costs no tokens. It tells the model to speak Czech, to keep every message to one short
paragraph, and never to narrate reasoning, progress, code, URLs or long lists. When `autoSummary` is
on, the section adds: after every finished answer, call `action=summary` with a Czech summary of one to
three sentences (max ~300 characters); when it is off, the model is told to read a summary only when
the user asks. While commercial mode is on without a personal-voice opt-in, the model is also told not
to use the macOS `say` voice.

### In the UI

- **Settings → Phononspeak** — a dedicated page with all fields below, engine cards with licence and
  size, install/repair buttons, and cloned-voice management.
- **Floating mini player** — play/pause/stop, what is speaking now, and the queue. If the browser
  refuses to start playback on its own (autoplay policy), the player offers a **Přehrát** button instead
  of failing silently.
- **Tool card** — a `dsh_phononspeak` call renders as its own card instead of raw JSON, with a
  "Play again" button that replays the last spoken text.
- **Attention banner** — "Agent tě volá" with a "Jsem tady" button that acknowledges the call.

Everything the UI shows comes from one place, `GET /dsh-phononspeak/state`; the 0.2.x Web client has
no settings service, so state and configuration travel over HTTP.

## Settings

These are user settings, persisted by the host to `~/.dsh/phononspeak/settings.json` (or to
`<dataDir>/settings.json` when the Cordis `dataDir` option is set). The Cordis `Config` itself is
infrastructure only: `dataDir`, `pythonPath`, `autoProvision`.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. When off, speaking actions are refused, the prompt section is empty, and automatic attention calls stop. `stop`, `status`, `voices`, `install` and `ack` still work. |
| `engine` | `auto` | `auto`, or one of `supertonic`, `piper`, `pocket`, `say`. |
| `voice` | `M1` | Voice id from `action=voices`. Supertonic offers F1–F5 and M1–M5. |
| `language` | `cs` | `cs` or `en`. |
| `speed` | `1.0` | Speaking rate, `0.7`–`1.6`. Clamped by the host. |
| `volume` | `1.0` | `0`–`1`, passed to `afplay -v` for system playback. |
| `autoSummary` | `false` | Read a summary after every answer. Also enables the corresponding prompt instruction. |
| `maxChars` | `300` | Hard cap on spoken characters; longer text is cut at a sentence boundary and announced as shortened. The page offers `100`–`1200`; the host clamps anything it receives to `40`–`1200`. |
| `attentionRepeatSec` | `0` | Repeat the attention line every N seconds until acknowledged. The page offers 0 / 15 / 30 / 60; the host accepts 0–600, and `0` means once. |
| `notify` | `true` | macOS notification on attention calls. |
| `systemPlayback` | `true` | Play through `afplay` when no visible browser tab can play. When off, output is always the page. |
| `dndFrom` / `dndTo` | `""` | Do-not-disturb window in local time, `HH:MM`–`HH:MM`. Empty means off. A window may wrap midnight (`22:00`–`07:00`). |
| `commercialMode` | `true` | Keep non-commercial engines out of every path — automatic chain **and** an explicit pick — and mark them in the engine cards. With the default `on`, `say` is refused unless you also enable the next field. |
| `allowPersonalVoice` | `false` | Explicit opt-in for macOS `say`, which Apple licenses for personal, non-commercial output only. |
| `voices` | `[]` | Named cloned voices: `{id, name, engine, path, createdAt, rightsConfirmed}`. |

Engine cards on the same page show, per engine, whether it is available and why not, its licence, its
size, and an **Install** / **Repair** button that starts provisioning and displays the progress
message. Cloned voices are added by name plus an absolute path to a wav file, and the form will not
submit without the "I have the right to use this voice" checkbox.

## Engines and licences

Licence is a feature here, not a footnote: an engine whose licence does not fit the context is kept
out of the automatic choice, and its licence is shown in the UI rather than buried. `auto` walks
**supertonic → piper → pocket → say**.

| Engine | Czech | Cloning | Licence | Size / runtime | Measured on the development Mac |
|---|---|---|---|---|---|
| **Supertonic 3** (default) | yes, 31 languages incl. `cs` | no | code MIT, weights OpenRAIL-M (commercial use allowed; ship the licence and its use restrictions, mark modified files) | 380 MB model, ~160 MB venv (ONNX) | 7.39 s of Czech audio in 1.65 s of steady-state compute; a cold call is slower — 3.4 s of audio in 2.2 s of wall time including model load; 44.1 kHz; 10 voice styles F1–F5/M1–M5 |
| **Piper** | yes, jirka / kasandra | no (fine-tuning possible) | engine GPL-3.0-or-later, called as a separate process, never bundled or downloaded; voices CC0 / CC-BY-4.0 | 60–80 MB per voice, no venv, bring your own binary | about 17× realtime; mispronounces ("Vltava" → "Voltava", "Kč" → "káčej") |
| **Pocket TTS Czech** | yes, and the only cloning path | yes, from a wav | CC-BY-4.0, attribution to ÚFAL / ParCzech | 438 MB model + ~1 GB Python/torch | CPU faster than realtime; trained on 976 h of parliamentary speech, so a formal adult register |
| **macOS `say`** | yes, Zuzana | no | Apple macOS SLA §2.F: personal, non-commercial use only; refused in commercial mode, even when named explicitly, until `allowPersonalVoice` is on | 0 MB | instant; robotic; the best Czech text normalisation of the four |

Piper is deliberately bring-your-own-binary: its engine licence is GPL-3.0-or-later, so the plugin
neither downloads nor bundles it — it only spawns the `piper` it finds on `PATH`, or the path in
`PHONONSPEAK_PIPER`. The voices are ordinary `.onnx` + `.onnx.json` pairs; the plugin looks for them in
`PHONONSPEAK_PIPER_VOICES`, `$HARNESS_AI/models/piper` and `~/.local/share/piper`.

`say` is refused while `commercialMode` is on and `allowPersonalVoice` is off: `auto` skips it, and an
explicit `engine=say` from a tool call or from the settings select returns a refusal instead of audio.
When no other engine is usable the job fails with a message rather than falling back to it. The refusal
is a value, not a crash — the tool reports it and the queue records it. Enabling `allowPersonalVoice`
is a statement that the output is personal and non-commercial, not a convenience switch.

Deliberately excluded, because their licences are not commercial: XTTS v2, ZipVoice-CZ, OmniVoice,
Higgs, Fish s2-pro and MMS. XTTS v2 is the sharpest case — CPML forbids commercial use of the model
*and its outputs*, and Coqui, the company that could have sold a commercial licence, no longer exists.

Details, ready-to-copy attribution lines and the OpenRAIL-M obligations: [docs/VOICES.md](docs/VOICES.md).

## Voice cloning and consent

Pocket TTS Czech clones a voice from a short wav recording. That is the only engine here that clones,
and the plugin treats it as an opt-in feature with a consent step, because the licence does not cover
what people usually mean by "a voice".

**What the licence covers.** CC-BY-4.0 covers the model and its training data (ParCzech, 976 hours of
parliamentary speech). It does **not** grant you a person's voice. Clone your own voice, or a voice
you have a written consent to use.

**The reference wavs are real people.** The six reference recordings shipped with the model are real
Czech members of parliament. Their personality rights still apply, whatever the model licence says.

**What the plugin stores.** Only the display name, the absolute path to your wav file, the engine id
and the rights confirmation flag — never a copy of the audio. Delete the voice and the file is
untouched; the plugin never owned it.

**The checkbox is mandatory.** The UI requires "I have the right to use this voice" and the host
refuses the request without it (HTTP 400), so no client can skip the step.

**Pocket never borrows a voice on its own.** The only voices the model ships are the six reference
recordings, and they belong to real people. So the host refuses to use Pocket without a voice you
registered: `auto` skips Pocket, and an explicit `engine=pocket` request returns an error asking for a
sample. Add your own wav (with the rights confirmation) and Pocket becomes usable.

**What to expect from a clone.** The timbre is recognisably close to the sample. Prosody and emotion
do not transfer: it sounds like someone else with a similar voice, not like you. A clean recording of
a few seconds to a few tens of seconds is the right input.

## How it works

```
  model ──► dsh_phononspeak tool ──► queue (attention > question > summary > manual > test)
                                          │
                                          ▼
                     normalise → split into sentences (≤220 chars) → synthesise one wav per sentence
                                          │
                        ┌─────────────────┴──────────────────┐
                        ▼                                    ▼
             visible tab: <audio> from                 no visible tab: afplay
             GET /dsh-phononspeak/audio/<id>.wav       + osascript notification
             (Range, pause, seek, stop)                 (macOS only)
```

One worker serialises everything, so two jobs never overlap. Every job has an id, a generation number
and a list of segments; a stop bumps the generation, which is what makes an in-flight synthesis and
everything queued behind it go away instead of finishing quietly.

The full picture — layers, the job state machine, why the state travels over HTTP instead of the
settings service, why `say` is gated in code and how provisioning works — is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Honest limitations

- **The Pocket model speaks like a parliament.** It was trained on 976 hours of Czech parliamentary
  speech: adults, formal register, many men. Conversational Czech, children and casual word order are
  weaker. Good narration, not a voice actor.
- **Piper mispronounces Czech words.** Measured on the raw engine: "Vltava" comes out as "Voltava" and
  "Kč" as "káčej". The normaliser rewrites money before synthesis, so "Kč" reaches the engine as
  "korun"; place names and loanwords are not rewritten, and those still slip. Piper is the cheapest
  engine, not the best one.
- **Supertonic has no streaming API.** We stream by sentence: the first sentence is synthesised and
  played while the next one is being made. That keeps the first sound early, but it is not a
  sample-level stream.
- **macOS-first.** Linux and Windows have no `say`, no `afplay` and no `osascript`. The engines still
  work, but sound comes from the page, and notification plus repeat-until-acknowledged are macOS
  features. When no tab is visible on a non-macOS host, the system-playback path has nothing to play.
- **Pocket costs about 1 GB** of Python and torch before the 438 MB model. Choose Supertonic or Piper
  if that is too much.
- **The plugin speaks what it is told.** It normalises and shortens text, but it cannot tell whether
  the model's summary is a good summary. A vague summary is read out as confidently as a precise one.
- **Speed is engine-dependent.** The host clamps every value to 0.7–1.6; `say` maps it to words per
  minute, Piper falls back to its default rate if its CLI rejects the flag, and Pocket TTS Czech has no
  speed control at all, so the slider does nothing on that engine.
- **Paragraph-level, not conversation-level.** There is no history of what was read, no per-message
  "read this" button, no keyboard shortcut and no slash command in 0.1.0.
- **The queue is bounded.** At most 24 waiting jobs: beyond that the oldest waiting job is dropped, and
  a single job is capped at 20 000 characters before normalisation.

## Troubleshooting

No sound, an engine that will not install, a queue that seems stuck, notification permissions, and
how to inspect the live state with `curl`:
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

The one command worth remembering:

```
curl -s http://127.0.0.1:<port>/dsh-phononspeak/state | python3 -m json.tool
```

## Privacy

The text you hear never leaves the machine: synthesis is local and there is no telemetry. The only
metadata kept — engine, duration, error — lives in memory and is published to the local page; the
spoken text is never written to a log. What is stored, where, and how to delete all of it:
[docs/PRIVACY.md](docs/PRIVACY.md).

## Development

```
lib/index.js      Host half: Config, settings, queue, HTTP routes, tool, prompt, events, provisioning
lib/contract.js   Route table, defaults, priorities, limits, state shape — the single source of names
lib/engines.js    Engine adapters (supertonic, piper, pocket, say), detection and synthesis
lib/normalize.js  Text normalisation and sentence splitting
lib/provision.js  Data paths, Python discovery and verification, venv creation with markers, model download
lib/client.js     Web half: settings page, mini player, tool card, attention banner
cordis.patch.yml  The bundle patch: one host row, id `phononspeak`
scripts/verify.mjs     Pre-release gate: manifest, patch, syntax, client vs contract, locale, tests, links
scripts/make-index.mjs Writes the plugin-market index.json from git HEAD and package.json
```

There is no build step: `lib/*.js` is shipped as-is (ESM, `node --check` clean). The Web half is a
separate browser module with no bundler, so it repeats the route literals from `lib/contract.js`;
`lib/contract.js` documents the intent that a contract test keeps the two in sync. No CI workflow is
published yet, so there is no CI badge on this page.

Useful checks while working on it:

```
node scripts/verify.mjs          # the pre-release gate: manifest, patch, syntax, client vs contract,
                                 # locale, icon, tests, and every relative link in both READMEs
node scripts/make-index.mjs      # writes the market index.json for the current commit and version
node --check lib/index.js && node --check lib/contract.js
curl -s http://127.0.0.1:<port>/dsh-phononspeak/state | python3 -m json.tool
dsh_phononspeak action=status
```

See also [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the HTTP surface and the queue contract.

## Licence

The plugin itself is MIT — see [LICENSE](LICENSE). The engines it can call are not MIT, and their
licences travel with them: [docs/VOICES.md](docs/VOICES.md) lists every one of them and what you may
ship.

## Attribution

- **Supertonic 3** — model and weights by Supertone. Code MIT, weights under OpenRAIL-M; the licence
  and its use restrictions must be passed on, and modified files must be marked.
- **Piper** — engine by the Rhasspy/Piper project, GPL-3.0-or-later from 1.3 (MIT up to 1.2.0),
  published as the `piper1-gpl` fork; called as a separate process and neither distributed nor
  downloaded by this plugin. Czech voices are CC0 or CC-BY-4.0 depending on the voice.
- **Pocket TTS Czech** — model by `vvolhejn`, CC-BY-4.0, trained on ParCzech4Speech (ÚFAL). Attribution
  to ÚFAL and the ParCzech corpus is required when you redistribute the model or its output.
- **macOS `say`** — Apple. Personal, non-commercial use only, per the macOS software licence
  agreement §2.F. Enforced by this plugin, not granted by it.
