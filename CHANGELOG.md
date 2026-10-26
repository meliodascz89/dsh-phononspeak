# Changelog

All notable changes to `dsh-phononspeak` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-26

### Fixed after the first live install

- **Transport**: the Web half now talks to the Host through a Typert Remote namespace
  (`phononspeak/*`) over the Connection carrier. A plain `fetch` from the Desktop renderer never
  reaches the Host's route table, and `connection.rpc.intercept('/api', …)` is owned by the Typert
  Gateway — a second interceptor is a fatal Host load failure. The HTTP routes remain for `dsh web`.
- **Crash safety**: the async initializer, the queue worker and every remote method settle into a value
  or a stored error, so no plugin path can reject into the Host.
- **Autoplay fallback**: a blocked `play()` is reported once per job and the Host speaks that job
  through `afplay`, instead of leaving the summary silent.

First release: a local, Czech-first voice channel for a DeepSeek Harness agent.

### Added

- **Host half** (`lib/index.js`): `Config` (`dataDir`, `pythonPath`, `autoProvision`), user settings
  persisted to `~/.dsh/phononspeak/settings.json`, engine detection and provisioning, a priority queue
  with one worker, and a real stop that aborts synthesis, kills the player, clears the queue and cancels
  the repeat timer.
- **The `dsh_phononspeak` tool** with `summary`, `attention`, `speak`, `stop`, `status`, `voices`,
  `install` and `ack`, returning JSON (`ok`, `kind`, `id`, `engine`, `voice`, `segments`, `shortened`,
  `text`, `output`).
- **Web half** (`lib/client.js`): a Settings page named Phononspeak with sections for status, voice,
  reading, privacy, engines and cloned voices; a floating mini player registered on `shell.overlay`
  with play/pause/stop and the "Jsem tady" attention banner; a tool card on `tool.call.toolview` keyed
  to `dsh_phononspeak`. One module-level store and one `HTMLAudioElement`, so two views never speak the
  same job twice; the page polls `/state` once a second while visible and every five seconds while
  hidden, reports `/presence`, and posts `{action:"finished"}` when playback ends. A rejected autoplay
  becomes a "Přehrát" button rather than an error.
- **A single HTTP surface**, all same-origin: `GET /state`, `POST /config`, `POST /action`,
  `POST /presence`, `POST`/`GET /setup`, and `GET /audio/<id>.wav` with `Range` support (206 responses),
  so the page can pause and seek one WAV per sentence.
- **Queue priorities** — attention > question > summary > manual > test — with a 24-job bound, one job
  at a time, and a generation counter so a stop discards everything in flight instead of finishing it.
- **Four engines, licence included**: Supertonic 3 (default, ONNX, 31 languages), Piper (60–80 MB per
  voice, no Python, bring your own GPL binary), Pocket TTS Czech (cloning, CC-BY-4.0) and macOS `say`.
  `auto` walks supertonic → piper → pocket → say.
- **Licence handling**: `commercialMode` defaults to on and `allowPersonalVoice` to off, so `auto` skips
  macOS `say` and an explicit `engine=say` request is refused with a message — the gate is a refusal,
  not a warning. A job with nothing else usable fails instead of falling back to it. The engine card
  carries the licence warning and the prompt tells the model not to use it.
- **Provisioning**: engine install/repair from the Settings page or `action=install`, progress in
  `state.setup`, one install at a time, and a background first-run attempt for Supertonic (about 0.5 GB)
  limited to once an hour.
- **Attention calls**: a spoken line, a macOS notification through `osascript`, an in-UI banner with
  "Jsem tady", and optional repetition every 15, 30 or 60 seconds until acknowledged.
- **Summary prompt section** (`phononspeak`, order 410), injected only while the feature is enabled and
  switched between "after every answer" and "only when asked" by `autoSummary`.
- **Automatic attention** from `approval/request` and `user-questions/request`, both waterfalls that
  always pass control through, and both suppressed during the quiet window.
- **Voice cloning with a consent step**: a name, an absolute wav path and a mandatory rights
  confirmation, stored as a path only — never a copy of the audio. An `addVoice` request without the
  confirmation is refused with HTTP 400.
- **Quiet hours** (`dndFrom`/`dndTo`, `HH:MM`, may wrap midnight): non-attention jobs are skipped without
  an error, attention stays audible.
- **Text normalisation** (`lib/normalize.js`): one ordered pipeline — Markdown and code fences out (a
  removed block is announced), URLs and file paths to words, emoji out, numbers, dates, money and units
  to Czech numerals with the right gender, dotted Czech abbreviations expanded, English terms
  transliterated — followed by abbreviation-aware sentence splitting and clause-boundary cuts into
  segments of at most 220 characters. A `maxChars` cap cuts at a sentence boundary and marks the job
  `shortened`.
- **Concurrency surface for other plugins**: `ctx.provide("dshPhononspeak", …)` with `paths`,
  `settings()`, `state()`, `speak()` and `stop()`.
- **Documentation**: `README.md` (English) and `README.cs.md` (Czech), `docs/ARCHITECTURE.md`,
  `docs/VOICES.md` (licences and attribution), `docs/PRIVACY.md`, `docs/TROUBLESHOOTING.md`.

### Notes

- Measured with the engine adapters on the development Mac: Supertonic renders 7.39 s of Czech audio in
  1.65 s of steady-state compute, while a cold call spends about 2.2 s of wall time on 3.4 s of audio
  because the model loads first (44.1 kHz, ten voice styles F1–F5/M1–M5); Piper runs at about 17×
  realtime; Pocket TTS Czech is faster than realtime on CPU. These are single-machine numbers, not
  guarantees.
- macOS first. Linux and Windows get the non-Apple engines and the in-page player, but no `say`, no
  `afplay` and no `osascript`.
- Deliberately not in this release: reading the agent's questions aloud, a "read this" button on every
  message, a keyboard shortcut, slash commands and a history of what was read.
- XTTS v2, ZipVoice-CZ, OmniVoice, Higgs, Fish s2-pro and MMS are excluded because their licences do not
  permit commercial use. XTTS v2 additionally has no company left to sell a commercial licence.
- The six reference wavs shipped with the Pocket model are recordings of real Czech members of
  parliament; personality rights still apply. Clone your own voice or one you have written consent for.
- There is no build step and no `prepare`/`install` lifecycle script: `lib/*.js` ships as prebuilt ESM,
  because pnpm runs build scripts for Git dependencies only after an explicit approval.
