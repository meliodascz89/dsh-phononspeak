# Privacy

Phononspeak is a local voice channel. The text you ask it to speak is synthesised on your machine and
is never sent anywhere: there is no cloud TTS service, no API key, and no upload of the text. This page
states exactly what is stored, where, for how long, and how to delete all of it.

## Short version

- **No telemetry.** The plugin sends nothing about you, your usage or your text to the author or to any
  third party.
- **No account, no key.** Nothing to sign up for, nothing to paste into a settings field.
- **Text stays local.** Normalisation, sentence splitting and synthesis all run in local processes.
- **Two things do leave the machine, both during provisioning:** the package downloads (`pip`) and the
  model weights. That is a download, not an upload — nothing about your text or your usage is part of
  it.

## What is stored

| Path | Contents | Why it exists |
|---|---|---|
| `~/.dsh/phononspeak/settings.json` | User settings (engine, voice, speed, volume, limits, DND window, licensing flags) and the cloned-voice registry: `id`, display name, absolute path to your wav, `engine: "pocket"`, `rightsConfirmed`, `createdAt`. Also the timestamp of the last automatic provisioning attempt. | Settings must survive a restart. |
| `~/.dsh/phononspeak/audio/` | One WAV file per sentence of every job: `<job-id>-<index>.wav`. | The page streams audio from these files; they are the playback buffer. |
| `~/.dsh/phononspeak/venv-supertonic/`, `~/.dsh/phononspeak/venv-pocket/` | Python virtualenvs used by the engines that need one, plus install marker files. | Keep engine dependencies out of your system Python. |
| `~/.dsh/phononspeak/bin/`, `~/.dsh/phononspeak/voices/` | Directory scaffolding used by the engines. | Engine-side helpers and voice assets, if an engine needs them. |
| `~/.cache/supertonic3` | Supertonic model weights (~380 MB). | Downloaded once, reused after that. `SUPERTONIC_CACHE_DIR` moves this location. |
| an existing Hugging Face hub | Pocket TTS Czech model snapshot, if it was already downloaded (`PHONONSPEAK_HF_HUB`, `HF_HUB_CACHE`, `HF_HOME/hub`, `$HARNESS_AI/models/huggingface/hub`, `~/.cache/huggingface/hub`). | Read where it already is — the plugin does not copy 438 MB into its own directory. |

If `DSH_HOME` is set, the plugin-owned directories move under `$DSH_HOME/phononspeak`. If the Cordis
`dataDir` option is set, it wins over both. The model cache stays outside the data directory on
purpose, so deleting a test data directory does not throw away a 380 MB download.

The plugin never copies your wav files. A cloned voice is a name plus a path to a file you own;
deleting the voice entry in the UI does not touch the file, and nothing in the plugin reads that file
except the synthesis call that needs it.

## What is kept in memory only

- The text of queued jobs, including a 160-character preview shown in the player.
- The last spoken text (`state.last`), so the player can offer "read that again".
- Engine, voice and synthesis duration of the last job, plus the last error message.
- `GET /dsh-phononspeak/state` exposes all of the above to the page, on the same origin.

This memory is cleared when the Harness process stops. It is not written to disk.

## What is not logged

The plugin writes **no log file**. There is no record of what was spoken, no history of reads, and no
analytics. The metadata the plugin keeps is the in-memory state above: engine, duration, error. The
only text that ever reaches `settings.json` is what you typed into a settings field.

Anything the Harness itself logs about tool calls is outside this plugin's control.

## Network access

| Situation | What happens |
|---|---|
| Normal speaking, stopping, changing settings | No network access at all. |
| First-run or manual engine install | `pip` fetches engine packages into a virtualenv, and the Supertonic model (or the Pocket model) is downloaded. About 0.5 GB for the default path. |
| The page playing audio | A same-origin request to `/dsh-phononspeak/audio/…` — the Harness web server, on your machine. |

No third-party fonts, scripts, pixels or beacons are loaded by the plugin. No cookies are set by the
plugin; the audio responses are marked `Cache-Control: private`.

## Retention

| Data | Retained until |
|---|---|
| Audio segments | Kept in a cache with a hard budget of 200 MB. The host prunes the oldest segments as it adds new ones, and it also prunes leftovers on startup, so the directory does not grow across runs. |
| Settings and the voice registry | Until you change them or delete the file. |
| Model weights and virtualenvs | Until you delete them; they are expensive to re-download, so the plugin never removes them on its own. |

The audio directory therefore behaves like a cache with a manual floor, not like a self-emptying
temporary folder. If spoken audio is sensitive, delete the directory (or the whole data directory)
when you are done.

## Deleting everything

Quit the Harness first, then:

```sh
rm -rf ~/.dsh/phononspeak          # settings, voice registry, audio, venvs
rm -rf ~/.cache/supertonic3        # Supertonic weights
```

If you set `DSH_HOME` or the Cordis `dataDir` option, delete that directory instead of
`~/.dsh/phononspeak`. If `SUPERTONIC_CACHE_DIR` points somewhere else, delete that path instead of
`~/.cache/supertonic3`.

The Pocket TTS Czech snapshot is not covered by those two commands: the plugin reads it from an
existing Hugging Face cache it does not own, and other tools may be using the same cache. Remove the
`models--vvolhejn--pocket-tts-czech` directory from that hub only if you no longer need it anywhere.

Your own voice samples are yours: the plugin never copied them, so there is nothing to delete on its
side. Remove the wav files wherever you keep them.

To remove the plugin itself:

```
plugin_manager action="remove_bundle" target="dsh-phononspeak"
```

Deleting the data directory before removing the bundle is safe: the plugin recreates what it needs on
the next start, minus your settings and cloned voices.

## The notification

An attention call posts a macOS notification through `osascript`. The notification body is the spoken
line, truncated to 140 characters, and macOS keeps it in Notification Center according to your own
system settings — the same as any other notification. If you do not want that, turn `notify` off; the
spoken line, the banner and the queue are unaffected.

## A note on the audio files

A WAV in the audio directory is a recording of whatever the agent said out loud. It contains no
metadata about you, but it is still speech content on disk. Treat the directory like any other
recording: keep it short-lived, and delete it when it is not needed.
