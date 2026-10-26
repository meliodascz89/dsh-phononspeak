# Troubleshooting

The plugin keeps one source of truth for what is happening — the state object — and most problems are
answered by looking at it. Ask the agent for it first:

```text
dsh_phononspeak action=status     # config, output side, engine availability, queue
dsh_phononspeak action=doctor     # transport diagnostics: webServer, route, RPC namespace
```

**Where the diagnostics come from.** The Desktop renderer runs on the `dsh-app://` scheme and reaches the
Host only through the Connection RPC carrier (namespace `phononspeak/*`). The HTTP routes below are
registered for a plain `dsh web` deployment and for development; a `curl` against the **Desktop** window
port is not a valid check, because that page never uses the HTTP routes either. If you run `dsh web`
explicitly, replace `<port>` with its port and the `curl` recipes work.

Read these fields first:

| Field | Tells you |
|---|---|
| `output` | Where the next job will play: `browser` or `system` |
| `config.enabled` | The master switch |
| `config.engine`, `config.voice` | What is configured |
| `engines[]` | One record per engine: `id`, `available`, `reason`, `commercial` |
| `queue`, `current` | What is waiting and what is speaking |
| `lastEngine` | Which engine and voice actually produced the last audio, and how long it took |
| `last` | The last spoken text, if any |
| `error` | The last error message, or `null` |
| `setup` | Engine provisioning: `{engine, status, message}` or `null` |

The same information, in a shape meant for the model, is `dsh_phononspeak action=status`.

## No sound at all

Work down this list; the state endpoint answers each step.

1. **Is it enabled?** `config.enabled` must be `true`. When it is off, speaking actions return
   `{"ok": false, "skipped": "Phononspeak je vypnutý."}` and the prompt section is empty. `stop`,
   `status`, `voices`, `install` and `ack` still answer, which can make the plugin look alive.
2. **Is it inside the quiet window?** If `dndFrom`/`dndTo` form a valid window and the current local time
   falls inside it, every non-attention job is skipped silently — no sound and no error, by design.
   Attention calls still play. Set both fields to empty to disable the window, or check the clock.
3. **Which output was chosen?** `output` is decided when a job starts:
   - `browser` — the page plays the audio. If the tab is in the background, the browser may refuse to
     start playback without a user gesture (autoplay policy). The player treats that as a normal state
     and shows a **Přehrát** button; press it, or click once inside the Harness window and ask for the
     text again. After a gesture the page is unlocked.
   - `system` — the host plays the file with `afplay`. That only works on macOS. On Linux and Windows
     there is no `afplay`, the spawn fails and the segment is lost, so keep the Harness window visible:
     a recent `visible` presence makes the host choose `browser`.
4. **Is `systemPlayback` off?** Then output is always `browser`, and sound depends entirely on the page.
5. **Is the volume at zero?** `config.volume` is passed to `afplay -v` for system playback. Set it back
   to `1` and test with `dsh_phononspeak action=test text="Zkouška."`.
6. **Is `say` being refused?** With `commercialMode` on and `allowPersonalVoice` off, `auto` skips
   `say` and an explicit `engine=say` is refused with a message naming the licence. Either install
   Supertonic or Piper, or — for personal, non-commercial output only — enable `allowPersonalVoice`.
   A refusal is reported as `{ok:false, error}`; it is never silent and never falls back.
7. **Is the engine available at all?** `engines[]` says which one is missing and why. See the next
   section.

If `error` is `null`, nothing failed: the audio was produced and the problem is on the output side.

## Engine unavailable

`dsh_phononspeak action=voices` re-probes the engines; `action=status` reports the last probe. Both
carry a `reason` per engine.

- **Python is missing or too old.** Supertonic and Pocket TTS Czech need Python **3.10 or newer** with
  the `venv` module. The installer searches `python3.13`, `python3.12`, `python3.11`, a few Homebrew
  paths, and finally a bare `python3` — and it verifies each candidate's version *before* creating a
  venv, so a pyenv shim that answers 3.8 is rejected instead of producing a half-built environment.
  If none of them is right, set the Cordis `pythonPath` option, or `PHONONSPEAK_PYTHON` in the
  environment the Harness runs in, and install the engine again.
- **The venv exists but the engine is still unavailable.** A virtualenv counts as installed only when
  its marker files are present; they are written after `pip` exits zero, so an interrupted install
  cannot look finished. Press **Install** (or `action=install`) again: an existing venv is repaired in
  place, not recreated, so you do not lose the download.
- **Piper cannot be installed by the plugin.** Its engine licence is GPL-3.0-or-later, so the plugin
  never downloads or bundles it: `action=install engine=piper` only re-checks and reports what is
  missing. Install `piper` yourself, or point `PHONONSPEAK_PIPER` at its absolute path, and put Czech
  `.onnx` + `.onnx.json` voice pairs in `~/.local/share/piper` (or `PHONONSPEAK_PIPER_VOICES`). A model
  without its JSON config is ignored, because it cannot load.
- **Pocket is heavy and has no neutral voice.** It needs a Python 3.10+ runtime with torch (~1 GB); if
  you already have a large environment, set `PHONONSPEAK_POCKET_PYTHON` to its interpreter instead of
  building another venv. Its only built-in voices are the six reference recordings of real members of
  parliament, so register your own sample under Settings → Phononspeak → Cloned voices and choose it.
- **The model is not downloaded yet.** Run `dsh_phononspeak action=install engine=supertonic` (or press
  **Install** on the engine card) and watch `setup.status` move from `running` to `done` or `failed`.
  A `failed` status carries the underlying message — usually a network error or a missing system
  library.
- **Offline.** Provisioning needs the network. Without it, use what is already installed: a Piper binary
  and voices, or `say` on macOS. Nothing in the plugin requires a download to answer `status`.
- **Only one install runs at a time.** A second request during an install returns the running one
  instead of starting a parallel install; the progress message stays the same until it finishes.
- **The engine is not on the `auto` chain you think.** `auto` walks supertonic → piper → pocket → say.
  Forcing `engine=piper` when Piper is missing fails the job rather than falling back; use `auto` when
  you want the fallback.

## The first-run download is slow

The default provisioning path downloads a Python virtualenv plus the Supertonic model — about 0.5 GB.
On a slow connection this takes a while, and it happens in the background so the Harness stays usable.

- Watch `setup.message`; it is replaced by every progress line the installer emits.
- The Supertonic weights live in `~/.cache/supertonic3` (or `SUPERTONIC_CACHE_DIR`), outside the data
  directory, so reinstalling into a different `dataDir` does not download them twice.
- If it fails, the automatic attempt is retried at most once an hour (the timestamp is kept in
  `settings.json` as `provisionAttemptAt`). To retry immediately, start the install by hand:
  `dsh_phononspeak action=install engine=supertonic`, or
  `curl -s -X POST -H 'content-type: application/json' -d '{"engine":"supertonic"}' http://127.0.0.1:<port>/dsh-phononspeak/setup`.
- Meanwhile, install Piper instead: it is 60 MB per voice, needs no Python, and is about 17× realtime.

## The queue looks stuck

- **A browser-owned job is waiting for the page.** When the output is `browser`, the host waits up to
  120 seconds for the page to report `{action: "finished"}`. A tab closed mid-playback makes the queue
  pause for up to two minutes. `dsh_phononspeak action=stop` clears it immediately.
- **An attention call is repeating.** With `attentionRepeatSec` above 0, the first sentence is repeated
  until you acknowledge. Acknowledge with the banner's "Jsem tady" button, `dsh_phononspeak action=ack`,
  or `action=stop`. Audio ending does **not** acknowledge a call — that is deliberate.
- **Two Harness windows are open.** Both report presence, so both may play and both may pause a
  browser-owned job. Close the extra window.
- **The queue is full.** At most 24 jobs wait; a 25th drops the oldest waiting one. `queue` in the state
  shows what is actually there.

## No macOS notification

Attention calls post a notification through `osascript`. If the sound arrives but the banner in
Notification Center does not:

- `config.notify` must be `true`, and notifications only exist on macOS.
- Check Focus / Do Not Disturb — a Focus mode silently swallows notifications.
- macOS attributes the notification to the application that runs the Harness process. Look for that
  application in **System Settings → Notifications** and allow it. The first delivery may also be the
  one that triggers the permission prompt.
- The plugin does not ask for any permission of its own; there is nothing to grant to Phononspeak.

The in-UI banner is independent of the system notification and does not need any permission.

## Reading and driving the state with curl

```sh
# whole state
curl -s http://127.0.0.1:<port>/dsh-phononspeak/state | python3 -m json.tool

# just the parts that answer "why is it silent?"
curl -s http://127.0.0.1:<port>/dsh-phononspeak/state \
  | python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({k: s[k] for k in ("output","config","engines","queue","current","error","setup","lastEngine")}, ensure_ascii=False, indent=2))'

# speak something
curl -s -X POST -H 'content-type: application/json' \
  -d '{"action":"summary","text":"Toto je zkouška stavu."}' \
  http://127.0.0.1:<port>/dsh-phononspeak/action

# change one setting (returns the fresh state)
curl -s -X POST -H 'content-type: application/json' \
  -d '{"patch":{"volume":0.8}}' \
  http://127.0.0.1:<port>/dsh-phononspeak/config

# tell the host a page is visible (this is what the Web client posts)
curl -s -X POST -H 'content-type: application/json' \
  -d '{"visible":true}' \
  http://127.0.0.1:<port>/dsh-phononspeak/presence

# provisioning progress
curl -s http://127.0.0.1:<port>/dsh-phononspeak/setup | python3 -m json.tool
```

Notes:

- Bodies are JSON and capped at 1 MB; a malformed body returns `{"ok": false, "error": "Neplatný JSON."}`.
- Unknown paths return 404 with `{"ok": false, "error": "Neznámá cesta."}`.
- The routes answer on the loopback interface because that is where the Harness listens. Do not expose
  that port to a network you do not trust: anyone who can reach it can make your machine speak.

## The audio plays, but the Czech is wrong

Most of this is already handled before the engine sees the text. The normaliser removes Markdown and
code fences (and announces a removed block), turns URLs and paths into words, drops emoji, expands
numbers, dates, money, units and dotted Czech abbreviations, and transliterates English terms — but only
for Czech (`language: "cs"`); with `language: "en"` those steps are skipped on purpose.

Check what was actually queued first: the tool result's `text` field is the normalised string that was
sent to the engine. If it reads the way you want and the audio still sounds wrong, the engine is the
limit:

- **Piper** mispronounces some Czech words: "Vltava" comes out as "Voltava". Money is rewritten before it
  reaches the engine, so "Kč" should say "korun"; place names and loanwords are not rewritten.
- **Supertonic** reads individual letters and unusual letter clusters its own way; it does not expand
  abbreviations by itself, which is why the normaliser does it.
- **`say`** has the best Czech text normalisation of the four, and the strictest licence.

What you can do: keep sentences short, avoid unexplained symbols, and pick a different engine when the
text is dense with names or numbers. The normaliser never invents content and never drops a sentence, so
if a word goes missing, that is a bug worth reporting rather than a tuning problem.

## The plugin seems not to load at all

- **Silent skip on peer ranges.** A Harness loader skips a plugin whose peer dependency range is not
  satisfied, and logs nothing. This package declares `@deepseek-ai/dsh-tools >=0.1.1-rc.2 <0.3.0`; a
  runtime outside that range will not load it. Older voice plugins with a `^0.1.0-rc.6` peer are the
  classic example of the same failure.
- **Two halves.** The host half provides the tool and the routes; the Web half provides the pages and
  the player. If the tool works but no UI appears, reload the Harness window so the client module is
  loaded.
- **Check the tool before the UI:** `dsh_phononspeak action=status` exercises the host half alone.
