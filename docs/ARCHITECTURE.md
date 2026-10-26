# Architecture

This document describes how `dsh-phononspeak` is put together: the four layers, the queue, the life of
one job, and the integration points that make the agent speak at the right moment. Everything here is
taken from `lib/index.js` and `lib/contract.js`; numbers are the limits the host enforces.

## Layers

```
┌──────────────────────────── Host half (Cordis plugin, Node, lib/index.js) ─────────────────────────┐
│  export Config (schemastery)   dataDir · pythonPath · autoProvision                              │
│  apply(ctx)                                                                                      │
│    ctx.tools          dsh_phononspeak (summary | attention | speak | stop | status | voices …)    │
│    ctx.webServer      /dsh-phononspeak/*  (prefix route, one handler)                            │
│    ctx.systemPrompt   section "phononspeak", order 410, text computed on every read              │
│    ctx.on             approval/request, user-questions/request (both waterfalls)                 │
│    ctx.provide        dshPhononspeak service for other plugins                                   │
│                                                                                                   │
│  settings            ~/.dsh/phononspeak/settings.json (user) + Config (infrastructure)           │
│  queue               one worker, priorities, generation counter, real stop                       │
│  provisioning        venv + model, at most one at a time, progress in state.setup                │
└───────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                │  Connection RPC  phononspeak/*
                                                │  /state · /config · /action · /presence · /setup
                                                │  /audio/<id>.wav  (Range)
┌───────────────────────────────────────────────┴─────────────────────────────────────────────────┐
│  Web half (browser module, lib/client.js)                                                        │
│    settings page "Phononspeak"  ·  floating mini player  ·  tool card  ·  attention banner        │
│    polls /state, reports /presence, posts /action (including the "finished" handshake)           │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                │
┌───────────────────────────────────────────────┴─────────────────────────────────────────────────┐
│  Engines (lib/engines.js) — child processes, never in-process libraries                          │
│    supertonic (ONNX in a venv)  ·  piper (60 MB per voice)  ·  pocket (cloned voices)  ·  say     │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                │
┌───────────────────────────────────────────────┴─────────────────────────────────────────────────┐
│  Text layer (lib/normalize.js) — markdown, code fences, URLs, emoji, numbers, dates, money, units, │
│  dotted Czech abbreviations and English terms → speakable Czech; then sentence-aware splitting    │
│  into segments of at most 220 characters                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The Host half owns settings, the queue, engine detection and provisioning, the HTTP surface, the tool,
the prompt section and the macOS hooks. It never synthesises audio itself, and the Web half never
touches settings: it renders whatever `/state` says and posts changes back.

`lib/contract.js` is the single place that names the public surface — routes, defaults, priorities,
engine order and limits. The Web half is a separate browser module with no bundler, so it cannot import
that file and repeats the route literals; a contract test is meant to keep the two in sync.

## The queue

Every announcement is a job. Jobs are sorted by priority and then by creation time:

| Priority | Kind | Where it comes from |
|---|---|---|
| `0` | `attention` | The `attention` action, and automatically from `approval/request` and `user-questions/request` |
| `1` | `question` | Speaking a question the agent asks (accepted by the host, not advertised in the tool description) |
| `2` | `summary` | The model's `action=summary` call after an answer |
| `3` | `manual` | `action=speak`, and the player's "replay" |
| `4` | `test` | The Settings page's test button |

A single worker (`pump`) pulls one job at a time and awaits it, so nothing ever overlaps — the reason
the queue exists at all is that two `afplay` calls in the same second used to talk over each other.
Priority decides *what runs next*, not what interrupts: a running job is never cut off by a more
important arrival, it only runs first afterwards.

Bounds: at most 24 waiting jobs, and when the queue is full the oldest *waiting* job is dropped rather
than rejecting the new one. One job carries at most 20 000 characters before normalisation.

A job is identified by `ps-<epoch-ms>-<6 random chars>`. Each job holds a **generation** number taken
from the host's counter at enqueue time.

## The life of a job

```
enqueue(kind, text, voice, engine)
   │  collapse whitespace, drop an empty text
   ▼
normalize(text, language)            ← lib/normalize.js: markdown and code fences out (a removed
   │                                   block is announced), URLs and paths to words, emoji out,
   │                                   numbers/dates/money/units to Czech numerals with gender,
   │                                   dotted abbreviations expanded, English terms transliterated
   │
   ▼
maxChars cap (default 300, hard cap 1200)
   │  cut at the last ". " / "! " / "? " inside the budget; if that lands too early (> 40 % of
   │  the budget) cut at a word boundary and append "…"; mark shortened = true
   ▼
splitSentences(text, 220)            ← abbreviation-aware sentence ends, then clause-boundary
   │                                   cuts for an over-long sentence; never mid-word
   │
   ▼
queue.sort(priority, createdAt) ──► pump() ──► runJob(job)
                                                │
                        ┌───────────────────────┴────────────────────────┐
                        ▼                                                ▼
              no engine usable                            engine chosen (forced id or `auto` chain)
              error in state, job complete                + voice resolved (requested → setting → first;
              (attention cleared)                            for Pocket a voice is a wav sample, not a style id)
                                                                      │
                                                                      ▼
                                              quiet hours? (non-attention jobs are skipped: no sound,
                                              no error, job.skipped = "quiet-hours")
                                                                      │
                                                                      ▼
                                       per sentence: synthesize(text, voice, speed, outFile, signal)
                                       (one child process, 60 s timeout, temp file then atomic move)
                                                                      │
                                              segment = {url, file, duration, index, bytes, ms}
                                              audioIndex[<job-id>-<i>.wav] = {file, createdAt, bytes}
                                              lastEngine = {engine, voice, ms}
                                                                      │
                        ┌─────────────────────────────────────────────┴─────────────────────┐
                        ▼                                                                   ▼
              output = "system"                                            output = "browser"
              await afplay -v <volume> <file>                              publish state, the page
              (macOS; other platforms: spawn fails,                             plays the Range URL,
               the promise resolves, audio is lost)                             then POSTs {action:"finished"}
                                                                                    │
                                                                                    ▼
                                                                     wait ≤ 120 s for the handshake so a
                                                                     closed tab cannot pin the queue
                                                                      │
                                                                      ▼
                                              job.complete = true, state.last = {id, kind, text, at},
                                              current = null, next job
```

Two fields are worth understanding because they explain most of the debugging:

- **`owner`** (`state.output`) is recomputed when the job *starts*, not when it was queued: you may have
  brought the window forward in the meantime.
- **`generation`** is checked before every segment and inside the browser wait. A stop increments the
  counter, so the job in flight returns at the next check instead of finishing quietly.

A synthesis error ends the job (`job.failReason`, `state.error`), clears it if it was an attention call,
and lets the worker continue with the next one. An empty text or a text that normalises to no sentence
at all is rejected at enqueue with a readable Czech error.

## Stop, replay, acknowledgement

`stop` (the tool action, or `POST /action {action:"stop"}`) is not a mute flag. It:

1. increments the generation, so every queued job is stale;
2. aborts the running `AbortController` (the synthesis child gets its signal);
3. sends `SIGTERM` to the active player child, if any;
4. clears the repeat interval;
5. empties the queue, drops the attention call and `current`.

`ack` (or the banner's "Jsem tady" button) is different: it clears the pending attention call and stops
the repeat timer, but leaves audio that is already playing alone. Audio ending never acknowledges an
attention call — only the user does. A dropped tab, on the other hand, cannot stall the queue: the
browser-owned job gives up after 120 seconds.

## Why RPC, and why HTTP is only a second door

The 0.2.x runtime removed the settings namespace/section API that older voice plugins used
(`settingsNamespace`, `installSettingsSection`), and the Web client has **no settings service at all**.
Passing audio or state through a settings document is therefore impossible on two counts: there is no
document to write, and base64 WAV in a settings payload was never a good idea.

The first attempt after that was the obvious one — register a prefix route on the Harness web server and
`fetch` it from the page. It does not work in the Desktop app, and the way it fails is worth recording:

- The Desktop renderer runs on the `dsh-app://` scheme; a relative `fetch('/dsh-phononspeak/state')` from
  that page never reaches the Host's HTTP route table. The Harness documentation says it plainly — the
  web server "serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC
  bridge" (`@deepseek-ai/dsh-host-webserver`).
- The next candidate, `connection.rpc.intercept('/api', …)`, is **not available to a plugin**: the Typert
  Gateway already owns that channel's single interceptor. Registering a second one throws
  `connection: shared RPC channel "/api" already has an interceptor`, and because the call sat in the
  plugin's async initializer the rejection became an unhandled rejection — which 0.2.x turns into a
  **fatal load failure** that restarts the whole Desktop app.

So the Host publishes a **Typert Remote namespace** named `phononspeak` (the same mechanism `dsh-rea`
uses for its Plugins-page status), and the page calls it through the Connection carrier:

```js
connection.rpc.call('/api', 'phononspeak/state', { args: { request: null } })
```

| Remote method | `request` | Value |
|---|---|---|
| `ping` | — | `{plugin, version, now}` |
| `state` | — | the whole UI state |
| `config` | `{patch}` | `{ok, config, state}` |
| `action` | `{action, …}` | the same JSON the tool returns |
| `presence` | `{visible}` | `{output}` |
| `setup` | `{engine}` | `{ok, provisioning}` |
| `setupStatus` | — | `{ok, setup}` |
| `audio` | `{id}` | `{dataUrl, bytes}` — one sentence as a base64 WAV data URL |

Every remote method is wrapped: a failure comes back as `{ok:false, error}` inside a successful call, never
as a rejection. That is deliberate. A plugin that can take the app down with one bad promise is not
finished, and the crash above is exactly how that lesson was learned.

The HTTP surface still exists and is still useful — for a plain `dsh web` deployment, and for `curl` while
developing. It is registered as one prefix route, retried briefly if the web server is not up yet, and
disposed with the fiber; a colliding path degrades to "no HTTP door" instead of failing the load:

| Method and path | Body | Response |
|---|---|---|
| `GET /dsh-phononspeak/state` | — | The whole UI state |
| `POST /dsh-phononspeak/config` | `{patch: {…}}` | `{ok, state, config}` |
| `POST /dsh-phononspeak/action` | `{action, …}` | The same JSON the tool returns |
| `POST /dsh-phononspeak/presence` | `{visible}` | `{ok, output}` |
| `POST /dsh-phononspeak/setup` | `{engine}` | `{ok, provisioning}` |
| `GET /dsh-phononspeak/setup` | — | `{ok, setup}` |
| `GET /dsh-phononspeak/audio/<id>.wav` | — | `audio/wav`, `Accept-Ranges: bytes`, 206 on a valid `Range` |

### Audio delivery

Over RPC a sentence arrives as a `data:` URL (~270 KB base64 for a few seconds of 44.1 kHz mono WAV) and
the page caches it per audio id for the life of the tab. Over HTTP the same bytes are a normal file with
`Range`, which is what gives `dsh web` pause and seek. The state object is rebuilt from live sources on
every read, so a poll never observes a half-updated queue.

`/action` also accepts four verbs that exist only for the Web half, not for the model: `finished` (the
playback handshake), `replay` (re-speak `state.last`, or a supplied text), `addVoice`
(`{name, path, rightsConfirmed}` — 400 without the confirmation, 400 if the path is not a file) and
`removeVoice` (`{id}`).

Request bodies are capped at 1 MB and must be JSON; every failure returns `{ok:false, error}` with 400,
404 or 500. No CORS headers are set, because the caller is the page on the same origin.

### Autoplay

Browsers refuse `audio.play()` without a user gesture, and a voice plugin that silently refuses to speak
is indistinguishable from a broken plugin. Three layers deal with that:

1. The page spends the **first** gesture (pointerdown, keydown or touchstart, anywhere) on a 10 ms silent
   WAV, after which model-driven playback is allowed.
2. If `play()` still rejects, the page reports `action: "blocked"` once per job and the Host hands that
   job to the system output — the summary is spoken through `afplay` instead of going unheard.
3. If neither side can play, the overlay shows a Play button and the Host clears the browser-owned job
   after 45 seconds so the queue cannot stall.

## Choosing an output

`pickOutput()` answers "where would the next job play?":

- `systemPlayback` off → always `browser`.
- Otherwise `browser` only when the page reported `visible: true` **within the last 6 seconds**
  (`presenceFreshMs`), else `system`.

The freshness window matters: a tab that was hidden and crashed never reports `visible: false`, it just
stops polling, and the host falls back to `afplay` on its own. On macOS that path also posts the
notification through `osascript` for attention calls.

## Why `say` is gated in code

The macOS licence agreement (§2.F, "Voices; Live Captions") allows the system voices only for personal,
non-commercial output. That is a licence of the platform, not of this plugin, so the plugin cannot grant
it — but it can refuse to make the mistake:

- `commercialMode` defaults to `true` and `allowPersonalVoice` to `false`.
- In `auto`, `say` is skipped while both are in that state.
- If nothing else in the chain is usable, the job fails with a message instead of falling back to it.
- The prompt section tells the model not to use it in that mode, and the engine card carries the
  licence warning.
- The config never persists a silent exception: the flags are visible settings, and the card says what
  they mean.

What the gate does **not** do: it does not override an explicit choice. `pickEngine(forced)` returns the
requested engine whenever it is available, so a call with `engine=say` — or a settings selection of
`say` — speaks even with commercial mode on. The gate is a rule about the *chain* (what the plugin picks
on its own), which is why the prompt and the UI warning carry the rest of the argument. A hard refusal
would have to live in `pickEngine`'s forced branch; until it does, treat the flags as a guard rail
rather than an enforcement mechanism.

The same restriction applies to Apple's Personal Voice, which is why the flag is named after the
personal use, not after the engine.

## Quiet hours

`dndFrom`/`dndTo` are local `HH:MM` values; a window may wrap midnight, and an invalid or missing value
means "off". Non-attention jobs inside the window are skipped before synthesis: no audio, no error, and
the job records `skipped = "quiet-hours"`. Attention stays audible — that is the one message a user
explicitly asked to hear even at night — but the *automatic* attention triggered by `approval/request`
and `user-questions/request` is suppressed during the window, so an agent working overnight does not
shout at an empty room.

## Engine provisioning

`POST /dsh-phononspeak/setup {engine}` (or the tool's `action=install`) starts provisioning:
`ensureEngine` creates or repairs the Python virtualenv and downloads the model. Only one provisioning
runs at a time; a second request returns the first one's promise instead of starting a parallel install.

Three decisions in `lib/provision.js` are worth knowing when an install fails:

- **The interpreter is discovered and verified, never assumed.** Candidates are tried in an order that
  gets a working Python fastest (`python3.13`, `python3.12`, `python3.11`, then explicit Homebrew paths,
  then a bare `python3`), and each candidate is asked for its major.minor version *before* any venv is
  created. Anything below 3.10 is rejected — a `python3` shim that answers 3.8 would otherwise build
  half a dependency tree and fail with a linker error. `pythonPath` (or `PHONONSPEAK_PYTHON`) pins the
  interpreter explicitly.
- **An existing venv is repaired, not recreated.** A marker file is written only after `pip` exits
  zero, so a failed install cannot look finished; a venv that exists but lacks a marker is repaired in
  place instead of deleting a 160 MB (or 1 GB, for Pocket) directory because one file is missing.
- **The model cache is shared.** Supertonic weights go to `~/.cache/supertonic3`, honouring
  `SUPERTONIC_CACHE_DIR` so the CLI and the detector cannot disagree about where the cache is; they do
  not live under `dataDir`, because 380 MB per test directory would be waste. Pocket TTS Czech is
  looked up as a snapshot in an existing Hugging Face hub (`PHONONSPEAK_HF_HUB`, `HF_HUB_CACHE`,
  `HF_HOME/hub`, `$HARNESS_AI/models/huggingface/hub`, `~/.cache/huggingface/hub`), and Piper voices are
  searched in `PHONONSPEAK_PIPER_VOICES`, `$HARNESS_AI/models/piper` and `~/.local/share/piper`.

Two engines are deliberately outside the installer:

- **Piper is bring-your-own-binary.** `ensureEngine("piper")` never downloads anything; it re-detects and
  throws with the reason. The binary comes from `PHONONSPEAK_PIPER` or `PATH`, the voices are
  `.onnx` + `.onnx.json` pairs, and a model without its JSON config is ignored because it cannot load.
- **Pocket needs a runtime and a voice sample.** The runtime is the plugin's own `venv-pocket` (torch,
  ~1 GB) unless `PHONONSPEAK_POCKET_PYTHON` names an existing interpreter; the voice is a wav sample.
  The six built-in voices are reference recordings of real members of parliament, so the host refuses to
  pick one: `pickVoice` returns nothing for Pocket unless the user registered a cloned voice, `auto`
  skips Pocket entirely in that state, and an explicit `engine=pocket` request fails with a message
  asking for a sample. Falling back to `voices[0]` would put a stranger's voice into the user's summary,
  which is exactly the consent mistake the UI exists to prevent.

Progress lives in `state.setup = {engine, status: "running"|"done"|"failed", message, startedAt}` and is
republished on every progress message, so the Settings page needs no separate channel. After success the
host re-detects engines, which is how a freshly installed model becomes selectable without a restart.

First start tries to be useful without being intrusive. When `autoProvision` is on, the plugin is
enabled, Supertonic is not available **and** no engine in the current chain is usable, the host
provisions Supertonic in the background — at most once per hour, tracked by `provisionAttemptAt` in
`settings.json`, so an offline machine is not retried in a loop.

Engine detection is cheap by design, and the two read paths differ on purpose. `action=voices` re-probes
the engines, and concurrent probes are coalesced into one; a finished probe is not cached, so the next
call probes again. `action=status` never blocks on a probe: it reports the availability from the last
one. Either way every record carries the reason an engine is missing, which is what the Settings page
and the troubleshooting guide read.

## Integration points

- **The tool, not an event, drives summaries.** `dsh_phononspeak action=summary` is a deliberate model
  decision, and the prompt section explains when to make it. There is no interception of the assistant
  message and no automatic scraping of the answer text.
- **`agent/turn-stopping` is not used.** It exists and would fire after every turn, but reading a summary
  from it would either duplicate the model's own summary or read text the model never chose to speak. The
  two mechanisms are mutually exclusive by design, and 0.1.0 keeps only the explicit one.
- **`approval/request` and `user-questions/request` drive attention.** Both are waterfalls: the handler
  starts an attention job (`"Potřebuji od tebe schválení."` / `"Mám na tebe otázku. Potřebuji odpověď."`)
  and always returns `next()`, so the approval flow and the question flow are never delayed or broken. If
  Phononspeak is disabled or inside quiet hours, nothing is said.
- **`ctx.provide("dshPhononspeak", …)`** exposes `paths`, `settings()`, `state()`, `speak(text, options)`
  and `stop`, so another plugin or a script can reuse the queue instead of re-implementing it.

## Limits the host enforces

| Constant | Value | Where it bites |
|---|---|---|
| `maxChars` | 1200 | Settings cap; the default spoken budget is 300 |
| `maxQueue` | 24 | Waiting jobs; the oldest waiting job is dropped |
| `maxText` | 20 000 | One job before normalisation |
| `segmentMaxChars` | 220 | Sentence split, and therefore one WAV per segment |
| `audioCacheBytes` | 200 MB | Declared audio budget in the contract |
| `statePollMs` | 1000 | Poll interval the contract suggests; the Web half polls every 5 s while hidden |
| `presenceFreshMs` | 6000 | After this, an unreported page counts as absent |
| body limit | 1 000 000 bytes | Every POST route |
| browser wait | 120 000 ms | How long a browser-owned job waits for `finished` |

## File map

| File | Responsibility |
|---|---|
| `lib/index.js` | Host half: `Config`, settings load/persist, queue and worker, HTTP handler, tool, prompt section, event hooks, provisioning entry points, `dshPhononspeak` service |
| `lib/contract.js` | Route table, `DEFAULTS`, `PRIORITY`, `AUTO_CHAIN`, `LIMITS`, `emptyState()`, clock and clamp helpers |
| `lib/engines.js` | `detectEngines`, `synthesize`, `ensureEngine`, `isEngineId` — the four adapters |
| `lib/normalize.js` | `normalizeForSpeech` (one ordered pipeline, seven switches), `splitSentences` (abbreviation-aware, clause-boundary cuts), and the Czech number/gender machinery |
| `lib/provision.js` | `enginePaths(dataDir)`, Python discovery and version verification, `ensureVenv`, `pipInstall`, Supertonic model download, Pocket snapshot and Piper voice discovery |
| `lib/client.js` | Web half: settings page, mini player, tool card, banner, state polling |
| `cordis.patch.yml` | Bundle patch: one row, `id: phononspeak`, `name: dsh-phononspeak` |
| `package.json` | `dsh.bundle.patch`, `dsh.client` (platform, immediate, locale/conversation/settings injections), peer ranges |
| `scripts/verify.mjs` | Pre-release gate: manifest, patch, syntax, client/contract route agreement, locale, icon, tests, README links |
| `scripts/make-index.mjs` | Generates the plugin-market `index.json` from git HEAD, version and a publish timestamp |

## Data on disk

| Path | Contents |
|---|---|
| `~/.dsh/phononspeak/settings.json` | User settings, cloned-voice registry (name + path + rights flag), last provisioning attempt |
| `~/.dsh/phononspeak/audio/` | WAV segments, one file per sentence per job; pruned by the host |
| `~/.dsh/phononspeak/venv-supertonic/`, `~/.dsh/phononspeak/venv-pocket/` | Python virtualenvs for the engines that need one, with install markers |
| `~/.dsh/phononspeak/bin/`, `~/.dsh/phononspeak/voices/` | Directory scaffolding used by the engines |
| `~/.cache/supertonic3` | Supertonic model weights (`SUPERTONIC_CACHE_DIR` overrides the location) |
| an existing Hugging Face hub | Pocket TTS Czech snapshot, read where it already is; not copied |

`DSH_HOME` moves the first four; the Cordis `dataDir` option moves them explicitly and takes
precedence. The model cache stays outside `dataDir` on purpose, so deleting a test data directory does
not throw away a 380 MB download. Details and deletion instructions: [PRIVACY.md](PRIVACY.md).
