//
//  index.js — the Host half of Phononspeak.
//
//  WHAT THIS PLUGIN IS FOR, and therefore what the code optimises:
//  the user asked for a voice that (a) reads a short summary of an answer and
//  (b) calls them to the computer when the agent needs a decision, that runs
//  locally and cheaply, and that they can configure from their own UI.
//
//  Three consequences drive the design:
//
//  1. A queue, not a fire-and-forget `afplay`. Two announcements in the same
//     second used to overlap; priorities make "come here" win over "here is a
//     summary", and `stop` actually stops.
//  2. One HTTP surface for everything the UI needs. In this runtime the Web
//     client has no settings service at all (0.2.x removed the old
//     `settingsScope` bridge), so state and configuration travel over
//     `/dsh-phononspeak/*` and the audio itself is a plain Range-capable URL
//     the browser can pause and seek.
//  3. Licensing is a first-class property of an engine, not a footnote. macOS
//     `say` may only be used for personal, non-commercial output; that is
//     enforced in code so a public build cannot silently ship it.
//
//  The Host owns: settings, the queue, engine provisioning, the HTTP routes,
//  the tool, the prompt section and the macOS hooks. The engines themselves
//  live in engines.js; text cleanup lives in normalize.js.
//

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat, unlink, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AUTO_CHAIN,
  DEFAULTS,
  ENGINE_IDS,
  LIMITS,
  PLUGIN,
  PRIORITY,
  ROUTE_PREFIX,
  ROUTES,
  VERSION,
  clampNumber,
  emptyState,
  inQuietHours,
  isPlainObject,
} from "./contract.js";
import { detectEngines, ensureEngine, isEngineId, synthesize } from "./engines.js";
import { normalizeForSpeech, splitSentences } from "./normalize.js";
import { enginePaths } from "./provision.js";

const name = "phononspeak";
const inject = ["tools"];

/**
 * Infrastructure only. Everything the user tunes lives in `settings.json`
 * behind the dedicated settings page, because the page must be able to write
 * values the generic plugin form cannot express (voice registry, DND window,
 * licensing switches). Keeping the two apart avoids two sources of truth.
 */
export const Config = z.object({
  dataDir: z.string().default(""),
  pythonPath: z.string().default(""),
  autoProvision: z.boolean().default(true),
});

/** Unwrap schemastery `.volatile()` cells that arrive as `{ get() }`. */
function readConfigValue(value) {
  if (value && typeof value === "object" && typeof value.get === "function") {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

function resolveConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    dataDir: String(readConfigValue(source.dataDir) ?? ""),
    pythonPath: String(readConfigValue(source.pythonPath) ?? ""),
    autoProvision: readConfigValue(source.autoProvision) !== false,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shortId() {
  return Math.random().toString(36).slice(2, 8);
}

/** Public, UI-facing projection of a job. Internal fields never leak. */
function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    text: job.text,
    owner: job.owner,
    segments: job.segments.map((segment) => ({ ...segment })),
    complete: job.complete,
    startedAt: job.startedAt,
  };
}

/** WAV/ AIFF duration from the file itself, so the UI can size a progress bar. */
async function audioInfo(file) {
  try {
    const buffer = await readFile(file);
    if (buffer.length < 44) return { bytes: buffer.length, duration: 0, sampleRate: 0 };
    // RIFF/WAVE
    if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
      let offset = 12;
      let sampleRate = 0;
      let channels = 1;
      let bits = 16;
      while (offset + 8 <= buffer.length) {
        const id = buffer.toString("ascii", offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        if (id === "fmt ") {
          channels = buffer.readUInt16LE(offset + 10);
          sampleRate = buffer.readUInt32LE(offset + 12);
          bits = buffer.readUInt16LE(offset + 22);
        } else if (id === "data") {
          const frames = size / Math.max(1, channels * (bits / 8));
          return {
            bytes: buffer.length,
            sampleRate,
            duration: sampleRate ? frames / sampleRate : 0,
          };
        }
        offset += 8 + size + (size % 2);
      }
      return { bytes: buffer.length, duration: 0, sampleRate };
    }
    return { bytes: buffer.length, duration: 0, sampleRate: 0 };
  } catch {
    return { bytes: 0, duration: 0, sampleRate: 0 };
  }
}

function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const dataDir = config.dataDir || join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "phononspeak");
  const paths = enginePaths(dataDir);
  const settingsFile = join(dataDir, "settings.json");
  const audioDir = paths.audioDir;

  /** Live settings; loaded from disk on apply, merged over defaults. */
  let settings = { ...DEFAULTS };
  let state = emptyState();
  let engineStatuses = [];
  let detection = null;
  let provisioning = null;
  let disposed = false;

  /** Queue + the single worker that serialises playback. */
  let queue = [];
  let current = null;
  let running = false;
  let generation = 0;
  let activeChild = null;
  let activeAbort = null;
  let repeatTimer = null;

  let presence = { visible: false, at: 0 };

  /** id → { file, createdAt, bytes } for the audio route. */
  const audioIndex = new Map();

  /** Engine cache: which engine actually spoke last, for the status line. */
  let lastEngine = null;
  let lastError = null;
  let setupState = null;
  let lastSpoken = null;
  let attentionJob = null;

  const now = () => Date.now();

  async function loadSettings() {
    try {
      const raw = JSON.parse(await readFile(settingsFile, "utf8"));
      if (isPlainObject(raw)) settings = { ...DEFAULTS, ...raw };
    } catch {
      /* first run: defaults */
    }
    settings.voices = Array.isArray(settings.voices) ? settings.voices : [];
    settings.engine = isEngineId(settings.engine) || settings.engine === "auto" ? settings.engine : "auto";
  }

  let saveTimer = null;
  function persistSettings() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8").catch(() => {});
    }, 250);
    saveTimer.unref?.();
  }

  function publish() {
    // The state object is rebuilt from live sources on every read, so a poll
    // can never observe a half-updated queue: readers get one synchronous copy.
    state = buildState();
    ctx.emit?.("phononspeak/state", state);
  }

  function buildState() {
    const output = pickOutput();
    return {
      ...emptyState(now()),
      config: { ...settings },
      output,
      engines: engineStatuses,
      voices: flatVoices(),
      current: publicJob(current),
      queue: queue.map((job) => ({ id: job.id, kind: job.kind, preview: job.text.slice(0, 160) })),
      attention: attentionJob ? attentionState() : null,
      last: lastSpoken,
      error: lastError,
      setup: setupState,
      lastEngine,
    };
  }

  function attentionState() {
    if (!attentionJob) return null;
    return {
      id: attentionJob.id,
      text: attentionJob.text,
      since: attentionJob.startedAt ?? attentionJob.createdAt,
      repeatEverySec: settings.attentionRepeatSec,
      acknowledged: false,
    };
  }

  function pickOutput() {
    if (!settings.systemPlayback) return "browser";
    const fresh = now() - presence.at < LIMITS.presenceFreshMs;
    return fresh && presence.visible ? "browser" : "system";
  }

  function flatVoices() {
    const list = [];
    for (const engine of engineStatuses) {
      if (engine.available) list.push(...(engine.voices ?? []));
    }
    for (const voice of settings.voices ?? []) {
      list.push({
        id: voice.id,
        label: voice.name || voice.id,
        engine: voice.engine || "pocket",
        language: settings.language,
        license: "CC-BY-4.0 (model), voice použita se souhlasem",
        cloning: true,
        sampleFile: voice.path,
      });
    }
    return list;
  }

  async function refreshEngines({ quiet = false } = {}) {
    if (detection) return detection;
    detection = (async () => {
      try {
        engineStatuses = await detectEngines({
          dataDir,
          env: { ...process.env, PHONONSPEAK_PYTHON: config.pythonPath || process.env.PHONONSPEAK_PYTHON || "" },
        });
      } catch (error) {
        if (!quiet) lastError = String(error?.message ?? error);
        engineStatuses = [];
      } finally {
        detection = null;
      }
      publish();
      return engineStatuses;
    })();
    return detection;
  }

  /** The engine chain actually used for a job. `auto` walks AUTO_CHAIN. */
  function engineAllowed(engine) {
    // `say` is licensed for personal, non-commercial output only. In commercial
    // mode it is refused even when explicitly requested — a warning label is not
    // a licence.
    if (engine.id === "say" && settings.commercialMode && !settings.allowPersonalVoice) return false;
    return true;
  }

  function pickEngine(forced) {
    const available = engineStatuses.filter((engine) => engine.available);
    if (forced && forced !== "auto") {
      const chosen = available.find((engine) => engine.id === forced) ?? null;
      if (chosen && !engineAllowed(chosen)) return null;
      return chosen;
    }
    for (const id of AUTO_CHAIN) {
      const found = available.find((engine) => engine.id === id);
      if (!found || !engineAllowed(found)) continue;
      // Pocket without an explicit cloned voice would fall back to a real
      // person's sample, so `auto` never selects it on its own.
      if (id === "pocket" && (settings.voices ?? []).every((voice) => voice.engine !== "pocket")) continue;
      return found;
    }
    // Nothing in the chain is usable. If the only thing left is the personal
    // voice, refuse rather than silently ship a non-commercial render.
    return settings.commercialMode && !settings.allowPersonalVoice ? null : available[0] ?? null;
  }

  function pickVoice(engine, requested) {
    const voices = engine?.voices ?? [];
    if (engine?.id === "pocket") {
      // Pocket's shipped references are recordings of real Czech MPs. Using one
      // because it sorted first is exactly the consent mistake the UI exists to
      // prevent, so pocket only speaks with a voice the user added explicitly.
      const clones = (settings.voices ?? []).filter((voice) => voice.engine === "pocket");
      if (clones.length === 0) return null;
      const wanted = requested || settings.voice;
      const match = clones.find((voice) => voice.id === wanted) ?? clones[0];
      return {
        id: match.id,
        label: match.name || match.id,
        engine: "pocket",
        language: settings.language,
        license: "CC-BY-4.0 (model), voice použita se souhlasem",
        cloning: true,
        sampleFile: match.path,
      };
    }
    const wanted = requested || settings.voice;
    return voices.find((voice) => voice.id === wanted) ?? voices[0] ?? null;
  }

  function enqueue({ kind, text, priority, voice, engine }) {
    const raw = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!raw) throw new Error("Prázdný text k přečtení.");
    const language = settings.language === "en" ? "en" : "cs";
    const maxChars = clampNumber(settings.maxChars, 100, LIMITS.maxChars, DEFAULTS.maxChars);
    let spoken = normalizeForSpeech(raw, { language });
    let shortened = false;
    if (spoken.length > maxChars) {
      // Cut at the last sentence boundary inside the budget — never mid-word.
      const head = spoken.slice(0, maxChars);
      const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
      spoken = cut > maxChars * 0.4 ? head.slice(0, cut + 1) : head.replace(/\s+\S*$/, "") + "…";
      shortened = true;
    }
    const sentences = splitSentences(spoken, LIMITS.segmentMaxChars);
    if (sentences.length === 0) throw new Error("Z textu nezůstala žádná věta k přečtení.");
    const job = {
      id: `ps-${now()}-${shortId()}`,
      kind,
      text: raw,
      spoken,
      shortened,
      sentences,
      segments: [],
      complete: false,
      createdAt: now(),
      priority: priority ?? PRIORITY[kind] ?? PRIORITY.manual,
      requestedVoice: voice || null,
      requestedEngine: engine || null,
      owner: pickOutput(),
      generation,
      failReason: null,
    };
    if (queue.length >= LIMITS.maxQueue) queue.shift();
    pruneAudio();
    queue.push(job);
    queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    publish();
    pump().catch((error) => {
      lastError = String(error?.message ?? error);
      publish();
    });
    return job;
  }

  /**
   * Keep the audio directory bounded. Files are content-addressed by job id, so
   * an entry is never needed by a running job once it was removed from the
   * index (the client already has the URL for a job it is playing).
   */
  /** Drop the oldest audio until the directory fits its byte budget. */
  function pruneAudio() {
    let total = 0;
    for (const entry of audioIndex.values()) total += entry.bytes || 0;
    if (total <= LIMITS.audioCacheBytes && audioIndex.size <= 400) return;
    for (const [key, entry] of audioIndex) {
      if (total <= LIMITS.audioCacheBytes * 0.75 && audioIndex.size <= 300) break;
      audioIndex.delete(key);
      total -= entry.bytes || 0;
      unlink(entry.file).catch(() => {});
    }
  }

  /**
   * Prune leftovers from earlier runs. The index only knows this process's
   * jobs, so a restart used to leave every old WAV behind forever; scanning the
   * directory keeps the documented ~200 MB budget true across restarts.
   */
  async function pruneStaleAudio() {
    let entries;
    try {
      entries = await readdir(audioDir);
    } catch {
      return;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.endsWith(".wav")) continue;
      try {
        const info = await stat(join(audioDir, entry));
        files.push({ file: join(audioDir, entry), size: info.size, at: info.mtimeMs });
      } catch {
        /* raced with a delete */
      }
    }
    files.sort((a, b) => a.at - b.at);
    let total = files.reduce((sum, item) => sum + item.size, 0);
    for (const item of files) {
      if (total <= LIMITS.audioCacheBytes) break;
      total -= item.size;
      unlink(item.file).catch(() => {});
    }
  }

  async function pump() {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && queue.length > 0) {
        const job = queue.shift();
        if (!job || job.generation !== generation) continue;
        try {
          await runJob(job);
        } catch (error) {
          // One bad job must not stop the queue or reject this promise: an
          // unhandled rejection is a fatal Host load failure in 0.2.x.
          lastError = `Přehrání selhalo: ${String(error?.message ?? error)}`;
          if (current === job) current = null;
          if (attentionJob === job) attentionJob = null;
          publish();
        }
      }
    } finally {
      running = false;
    }
  }

  function cancelActive() {
    generation += 1;
    if (activeAbort) {
      try {
        activeAbort.abort();
      } catch {
        /* already aborted */
      }
      activeAbort = null;
    }
    if (activeChild) {
      try {
        activeChild.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      activeChild = null;
    }
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  }

  async function runJob(job) {
    current = job;
    job.startedAt = now();
    // The output side is decided when the job starts, not when it was queued:
    // the user may have brought the window forward in between.
    job.owner = pickOutput();
    if (job.kind === "attention") attentionJob = job;
    publish();

    const engine = pickEngine(job.requestedEngine) ?? (await (async () => {
      await refreshEngines({ quiet: true });
      return pickEngine(job.requestedEngine);
    })());

    if (!engine) {
      const sayAvailable = engineStatuses.some((entry) => entry.id === "say" && entry.available);
      lastError = sayAvailable && settings.commercialMode && !settings.allowPersonalVoice
        ? "Jediný dostupný hlas je macOS say, který licence dovoluje jen pro osobní nekomerční použití. Nainstaluj Supertonic, nebo v nastavení povol osobní hlas."
        : "Žádný hlasový engine není k dispozici. Otevři nastavení Phononspeak a nainstaluj model.";
      job.complete = true;
      if (attentionJob?.id === job.id) attentionJob = null;
      publish();
      current = null;
      return;
    }

    const voice = pickVoice(engine, job.requestedVoice);
    const voicePath = resolveVoicePath(voice);
    const jobGeneration = job.generation;

    // Attention is never silenced by the quiet window — that is the one message
    // the user asked to hear even at night.
    if (job.kind !== "attention" && inQuietHours(settings)) {
      lastError = null;
      job.complete = true;
      job.skipped = "quiet-hours";
      publish();
      current = null;
      return;
    }

    if (job.kind === "attention") {
      notifyAttention(job.text);
      scheduleRepeat(job);
    }

    for (let index = 0; index < job.sentences.length; index++) {
      if (jobGeneration !== generation || disposed) return;
      const sentence = job.sentences[index];
      const outFile = join(audioDir, `${job.id}-${index}.wav`);
      activeAbort = new AbortController();
      const startedAt = now();
      try {
        const result = await synthesize({
          engineId: engine.id,
          text: sentence,
          voice: voice?.id ?? settings.voice,
          voicePath,
          language: settings.language === "en" ? "en" : "cs",
          speed: clampNumber(settings.speed, 0.7, 1.6, 1),
          outFile,
          dataDir,
          env: { ...process.env, PHONONSPEAK_PYTHON: config.pythonPath || process.env.PHONONSPEAK_PYTHON || "" },
          signal: activeAbort.signal,
        });
        activeAbort = null;
        const info = await audioInfo(result.file ?? outFile);
        const audioId = `${job.id}-${index}.wav`;
        const segment = {
          url: `${ROUTES.audio}${encodeURIComponent(audioId)}`,
          audioId,
          file: result.file ?? outFile,
          duration: Number(info.duration.toFixed(3)),
          index,
          bytes: info.bytes,
          ms: now() - startedAt,
        };
        job.segments.push(segment);
        audioIndex.set(audioId, { file: segment.file, createdAt: now(), bytes: info.bytes });
        lastEngine = { engine: engine.id, voice: voice?.id ?? settings.voice, ms: now() - startedAt };
        if (job.owner === "system") await systemPlay(segment.file);
        publish();
      } catch (error) {
        activeAbort = null;
        if (jobGeneration !== generation) return;
        job.failReason = String(error?.message ?? error);
        lastError = `Syntéza selhala (${engine.id}): ${job.failReason}`;
        job.complete = true;
        if (attentionJob?.id === job.id) attentionJob = null;
        publish();
        current = null;
        return;
      }
    }

    job.complete = true;
    lastSpoken = { id: job.id, kind: job.kind, text: job.text, at: now() };
    publish();

    // Browser-owned audio finishes when the client reports `finished`; the
    // timeout keeps a closed tab from pinning the queue forever.
    if (job.owner === "browser") {
      const deadline = now() + 45000;
      while (!disposed && current === job && now() < deadline) {
        if (jobGeneration !== generation) return;
        await sleep(500);
        if (job.finished) break;
      }
    }
    // An attention call is cleared by the user (ack), never by audio ending.
    if (current === job) current = null;
    publish();
  }

  function resolveVoicePath(voice) {
    if (!voice) return null;
    if (voice.sampleFile) return voice.sampleFile;
    const user = (settings.voices ?? []).find((entry) => entry.id === voice.id);
    if (user?.path) return user.path;
    return null;
  }

  async function systemPlay(file) {
    if (!settings.systemPlayback) return;
    const volume = clampNumber(settings.volume, 0, 1, 1);
    await new Promise((resolve) => {
      try {
        const child = spawn("/usr/bin/afplay", ["-v", String(volume), file], { stdio: "ignore" });
        activeChild = child;
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            /* gone */
          }
          resolve();
        }, 120000);
        timer.unref?.();
        child.on("exit", () => {
          clearTimeout(timer);
          if (activeChild === child) activeChild = null;
          resolve();
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  function notifyAttention(text) {
    if (!settings.notify || process.platform !== "darwin") return;
    const body = String(text).replace(/["\\\n]/g, " ").slice(0, 140);
    try {
      const child = spawn(
        "/usr/bin/osascript",
        ["-e", `display notification ${JSON.stringify(body)} with title "Phononspeak — potřebuji tě"`],
        { stdio: "ignore" },
      );
      child.unref?.();
    } catch {
      /* notifications are best effort */
    }
  }

  function scheduleRepeat(job) {
    if (repeatTimer) clearInterval(repeatTimer);
    const seconds = clampNumber(settings.attentionRepeatSec, 0, 600, 0);
    if (!seconds) return;
    repeatTimer = setInterval(() => {
      if (disposed || attentionJob?.id !== job.id || job.finished) {
        clearInterval(repeatTimer);
        repeatTimer = null;
        return;
      }
      // Re-speak only the first sentence: it is the actionable part.
      const sentence = job.sentences[0];
      if (!sentence) return;
      void speakOnce(sentence, job).catch(() => {});
    }, seconds * 1000);
    repeatTimer.unref?.();
  }

  async function speakOnce(sentence, job) {
    const engine = pickEngine(job.requestedEngine);
    if (!engine) return;
    const voice = pickVoice(engine, job.requestedVoice);
    const outFile = join(audioDir, `repeat-${job.id}-${shortId()}.wav`);
    const result = await synthesize({
      engineId: engine.id,
      text: sentence,
      voice: voice?.id ?? settings.voice,
      voicePath: resolveVoicePath(voice),
      language: settings.language,
      speed: clampNumber(settings.speed, 0.7, 1.6, 1),
      outFile,
      dataDir,
      env: { ...process.env, PHONONSPEAK_PYTHON: config.pythonPath || process.env.PHONONSPEAK_PYTHON || "" },
    });
    await systemPlay(result.file ?? outFile);
  }

  function stopAll() {
    cancelActive();
    queue = [];
    if (attentionJob) attentionJob = null;
    current = null;
    publish();
  }

  function acknowledge(id) {
    if (attentionJob && (!id || attentionJob.id === id)) {
      attentionJob.finished = true;
      attentionJob = null;
      if (repeatTimer) {
        clearInterval(repeatTimer);
        repeatTimer = null;
      }
      publish();
      return true;
    }
    return false;
  }

  function updateSettings(patch) {
    if (!isPlainObject(patch)) throw new Error("Konfigurace musí být objekt.");
    const next = { ...settings };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;
      if (key === "enabled") next.enabled = Boolean(value);
      else if (key === "engine") next.engine = value === "auto" || isEngineId(value) ? value : next.engine;
      else if (key === "voice") next.voice = String(value ?? next.voice);
      else if (key === "language") next.language = value === "en" ? "en" : "cs";
      else if (key === "speed") next.speed = clampNumber(value, 0.7, 1.6, next.speed);
      else if (key === "volume") next.volume = clampNumber(value, 0, 1, next.volume);
      else if (key === "maxChars") next.maxChars = clampNumber(value, 100, LIMITS.maxChars, next.maxChars);
      else if (key === "attentionRepeatSec") next.attentionRepeatSec = clampNumber(value, 0, 600, next.attentionRepeatSec);
      else if (key === "autoSummary" || key === "systemPlayback" || key === "notify" || key === "commercialMode" || key === "allowPersonalVoice") {
        next[key] = Boolean(value);
      } else if (key === "dndFrom" || key === "dndTo") next[key] = String(value ?? "");
      else if (key === "voices") {
        if (!Array.isArray(value)) continue;
        next.voices = value
          .filter((entry) => isPlainObject(entry) && typeof entry.path === "string" && entry.path)
          .map((entry) => ({
            id: String(entry.id ?? `voice-${shortId()}`),
            name: String(entry.name ?? "Klonovaný hlas").slice(0, 80),
            engine: entry.engine === "pocket" ? "pocket" : "pocket",
            path: String(entry.path),
            rightsConfirmed: Boolean(entry.rightsConfirmed),
            createdAt: Number(entry.createdAt) || now(),
          }));
      }
    }
    settings = next;
    persistSettings();
    publish();
    return settings;
  }

  /** Resolve the tool's action surface; every branch returns JSON-able data. */
  async function runAction(input) {
    const action = String(input?.action ?? "").toLowerCase();
    if (action === "status") {
      return {
        ok: true,
        enabled: settings.enabled,
        engine: settings.engine,
        voice: settings.voice,
        language: settings.language,
        autoSummary: settings.autoSummary,
        output: pickOutput(),
        engines: engineStatuses.map((engine) => ({
          id: engine.id,
          available: engine.available,
          reason: engine.reason,
          commercial: engine.commercial,
        })),
        queue: queue.length,
        current: current ? { id: current.id, kind: current.kind } : null,
      };
    }
    if (action === "voices") {
      await refreshEngines({ quiet: true });
      return { ok: true, voices: flatVoices(), engines: engineStatuses };
    }
    if (action === "stop") {
      stopAll();
      return { ok: true, stopped: true };
    }
    if (action === "state") {
      return { ok: true, state: buildState() };
    }
    if (action === "config") {
      const patch = isPlainObject(input?.patch) ? input.patch : {};
      const next = updateSettings(patch);
      return { ok: true, config: next, output: pickOutput() };
    }
    if (action === "doctor") {
      const webServer = ctx.get("webServer");
      return {
        ok: true,
        webServer: Boolean(webServer),
        origin: webServer && typeof webServer.getOrigin === "function" ? webServer.getOrigin() : null,
        routeRegistered: Boolean(routeDispose),
        rpcRegistered: remoteMounted,
        dataDir,
        installDir: new URL("..", import.meta.url).pathname,
      };
    }
    if (action === "install" || action === "setup") {
      const engine = String(input?.engine ?? "supertonic");
      provision(engine).catch(() => {});
      return { ok: true, installing: engine };
    }
    if (action === "ack") {
      return { ok: acknowledge(input?.id ? String(input.id) : undefined) };
    }
    if (!settings.enabled) return { ok: false, skipped: "Phononspeak je vypnutý." };
    // Refuse a disallowed engine synchronously: queueing a job that can only
    // fail later is a worse answer than an explicit refusal now.
    if (input?.engine && input.engine !== "auto") {
      const candidate = engineStatuses.find((engine) => engine.id === input.engine);
      if (!candidate) return { ok: false, error: `Neznámý engine: ${input.engine}` };
      if (!engineAllowed(candidate)) {
        return {
          ok: false,
          error:
            "macOS say je licencí omezený na osobní, nekomerční výstup. Vypni commercialMode nebo zapni allowPersonalVoice, jinak použij supertonic nebo piper.",
          refused: "licence",
        };
      }
      if (!candidate.available) {
        return { ok: false, error: `Engine ${input.engine} není připravený: ${candidate.reason ?? "neznámý důvod"}` };
      }
    }
    if (!["speak", "summary", "attention", "test", "question"].includes(action)) {
      return { ok: false, error: `Neznámá akce: ${action || "(prázdná)"}` };
    }
    const kind = action === "test" ? "test" : action === "attention" ? "attention" : action === "summary" ? "summary" : action === "question" ? "question" : "manual";
    const text = action === "test" ? input?.text || "Ahoj, tady Phononspeak. Test hlasu proběhl úspěšně." : input?.text;
    if (!text) return { ok: false, error: "Akce potřebuje text." };
    if (String(text).length > LIMITS.maxText) return { ok: false, error: "Text je příliš dlouhý." };
    const job = enqueue({
      kind,
      text,
      priority: PRIORITY[kind],
      voice: input?.voice,
      engine: input?.engine,
    });
    return {
      ok: true,
      kind,
      id: job.id,
      engine: settings.engine,
      voice: settings.voice,
      segments: job.sentences.length,
      shortened: job.shortened,
      text: job.spoken,
      output: job.owner,
    };
  }

  async function provision(engineId) {
    if (provisioning) return provisioning;
    setupState = { engine: engineId, status: "running", message: "Připravuji…", startedAt: now() };
    publish();
    provisioning = (async () => {
      try {
        await ensureEngine(engineId, {
          dataDir,
          env: { ...process.env, PHONONSPEAK_PYTHON: config.pythonPath || process.env.PHONONSPEAK_PYTHON || "" },
          onProgress: (message) => {
            setupState = { ...setupState, message: String(message).slice(0, 300) };
            publish();
          },
        });
        setupState = { engine: engineId, status: "done", message: "Hotovo.", startedAt: setupState.startedAt };
        await refreshEngines({ quiet: true });
      } catch (error) {
        setupState = {
          engine: engineId,
          status: "failed",
          message: String(error?.message ?? error).slice(0, 400),
          startedAt: setupState?.startedAt ?? now(),
        };
      } finally {
        provisioning = null;
        publish();
      }
    })();
    return provisioning;
  }

  /* ------------------------------------------------------------------ HTTP */

  function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(data),
    });
    res.end(data);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_000_000) throw new Error("Tělo požadavku je příliš velké.");
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Neplatný JSON.");
    }
  }

  async function serveAudio(req, res, filename) {
    if (!/^[A-Za-z0-9._-]+\.wav$/.test(filename)) {
      sendJson(res, 400, { ok: false, error: "Neplatný název souboru." });
      return;
    }
    const entry = audioIndex.get(filename);
    const file = entry?.file ?? join(audioDir, filename);
    let total;
    try {
      total = (await stat(file)).size;
    } catch {
      sendJson(res, 404, { ok: false, error: "Soubor nenalezen." });
      return;
    }
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (match) {
        const start = match[1] === "" ? 0 : Number(match[1]);
        const end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
        if (start >= 0 && end >= start) {
          const buffer = await readFile(file);
          const slice = buffer.subarray(start, end + 1);
          res.writeHead(206, {
            "Content-Type": "audio/wav",
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": slice.length,
            "Cache-Control": "private, max-age=300",
          });
          res.end(slice);
          return;
        }
      }
    }
    const buffer = await readFile(file);
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": buffer.length,
      "Cache-Control": "private, max-age=300",
    });
    res.end(buffer);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    try {
      if (path === ROUTES.state && req.method === "GET") {
        sendJson(res, 200, buildState());
        return;
      }
      if (path === ROUTES.config && req.method === "POST") {
        const body = await readBody(req);
        const patch = isPlainObject(body?.patch) ? body.patch : isPlainObject(body) ? body : {};
        const next = updateSettings(patch);
        sendJson(res, 200, { ok: true, state: buildState(), config: next });
        return;
      }
      if (path === ROUTES.action && req.method === "POST") {
        const body = await readBody(req);
        if (body?.action === "finished") {
          if (current && (!body.id || current.id === body.id)) {
            current.finished = true;
            if (attentionJob?.id === current.id) {
              // An attention call is acknowledged by the user, not by audio ending.
            }
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (body?.action === "replay") {
          const last = lastSpoken;
          if (!last) {
            sendJson(res, 200, { ok: false, error: "Zatím nic neřeklo." });
            return;
          }
          const job = enqueue({ kind: "manual", text: body.text || last.text, priority: PRIORITY.manual });
          sendJson(res, 200, { ok: true, id: job.id, segments: job.sentences.length });
          return;
        }
        if (body?.action === "addVoice") {
          const path = String(body.path ?? "").trim();
          if (!path) {
            sendJson(res, 400, { ok: false, error: "Chybí cesta ke vzorku." });
            return;
          }
          if (!body.rightsConfirmed) {
            sendJson(res, 400, { ok: false, error: "Potvrď, že máš právo hlas použít." });
            return;
          }
          try {
            const info = await stat(path);
            if (!info.isFile()) throw new Error("Není soubor.");
          } catch {
            sendJson(res, 400, { ok: false, error: "Soubor se vzorkem neexistuje." });
            return;
          }
          const voice = {
            id: `clone-${shortId()}`,
            name: String(body.name ?? "Klonovaný hlas").slice(0, 80),
            engine: "pocket",
            path,
            rightsConfirmed: true,
            createdAt: now(),
          };
          updateSettings({ voices: [...(settings.voices ?? []), voice] });
          sendJson(res, 200, { ok: true, voice, state: buildState() });
          return;
        }
        if (body?.action === "removeVoice") {
          const id = String(body.id ?? "");
          updateSettings({ voices: (settings.voices ?? []).filter((voice) => voice.id !== id) });
          sendJson(res, 200, { ok: true, state: buildState() });
          return;
        }
        const result = await runAction(body ?? {});
        sendJson(res, 200, result);
        return;
      }
      if (path === ROUTES.presence && req.method === "POST") {
        const body = await readBody(req);
        presence = { visible: Boolean(body?.visible), at: now() };
        sendJson(res, 200, { ok: true, output: pickOutput() });
        return;
      }
      if (path === ROUTES.setup && req.method === "POST") {
        const body = await readBody(req);
        const engine = String(body?.engine ?? "supertonic");
        if (!isEngineId(engine)) {
          sendJson(res, 400, { ok: false, error: "Neznámý engine." });
          return;
        }
        provision(engine).catch(() => {});
        sendJson(res, 200, { ok: true, provisioning: engine });
        return;
      }
      if (path === ROUTES.setup && req.method === "GET") {
        sendJson(res, 200, { ok: true, setup: setupState });
        return;
      }
      if (path.startsWith(ROUTES.audio) && req.method === "GET") {
        await serveAudio(req, res, decodeURIComponent(path.slice(ROUTES.audio.length)));
        return;
      }
      sendJson(res, 404, { ok: false, error: "Neznámá cesta." });
    } catch (error) {
      lastError = String(error?.message ?? error);
      sendJson(res, 500, { ok: false, error: lastError });
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  /* ------------------------------------------------------------------ RPC */

  // HOW THE BROWSER TALKS TO THIS PROCESS.
  //
  // MEASURED on 0.2.1-rc.3, twice, the hard way:
  //  - a static bundle's page has no settings service, and its plain
  //    `fetch('/dsh-phononspeak/...')` is not answered by the Host route table
  //    (the Desktop renderer carries host work over the Connection carrier);
  //  - `connection.rpc.intercept('/api', …)` is NOT available to a plugin: the
  //    Typert Gateway already owns that channel's single interceptor, and a
  //    second registration fails the whole Host load.
  //
  // The supported seam is a Typert Remote namespace (same pattern as dsh-rea):
  // the gateway dispatches `phononspeak/<method>` from
  // `connection.rpc.call('/api', …)` to this class. Every method is wrapped so
  // a failure becomes an `{ ok:false }` value instead of an exception — a plugin
  // must never take the Host down with it.
  let remoteMounted = false;

  async function handleRpc(method, request) {
    switch (method) {
      case "ping":
        return { ok: true, plugin: PLUGIN, version: VERSION, now: now() };
      case "state":
        return buildState();
      case "config": {
        const patch = isPlainObject(request?.patch) ? request.patch : {};
        const next = updateSettings(patch);
        return { ok: true, config: next, state: buildState() };
      }
      case "action": {
        const body = request ?? {};
        if (body.action === "finished") {
          if (current && (!body.id || current.id === body.id)) current.finished = true;
          return { ok: true };
        }
        if (body.action === "replay") {
          if (!lastSpoken) return { ok: false, error: "Zatím nic neřeklo." };
          const job = enqueue({ kind: "manual", text: body.text || lastSpoken.text, priority: PRIORITY.manual });
          return { ok: true, id: job.id, segments: job.sentences.length };
        }
        return runAction(body);
      }
      case "presence":
        presence = { visible: Boolean(request?.visible), at: now() };
        return { ok: true, output: pickOutput() };
      case "setup": {
        const engine = String(request?.engine ?? "supertonic");
        if (!isEngineId(engine)) return { ok: false, error: "Neznámý engine." };
        void provision(engine).catch(() => {});
        return { ok: true, provisioning: engine };
      }
      case "setupStatus":
        return { ok: true, setup: setupState };
      case "audio": {
        const filename = String(request?.id ?? "");
        if (!/^[A-Za-z0-9._-]+\.wav$/.test(filename)) return { ok: false, error: "Neplatný název souboru." };
        const entry = audioIndex.get(filename);
        const file = entry?.file ?? join(audioDir, filename);
        try {
          const buffer = await readFile(file);
          return { ok: true, dataUrl: "data:audio/wav;base64," + buffer.toString("base64"), bytes: buffer.length };
        } catch {
          return { ok: false, error: "Soubor nenalezen." };
        }
      }
      default:
        return { ok: false, error: `Neznámá RPC metoda: ${method}` };
    }
  }

  /** Mark one `@Remote(method)` method without decorator syntax (dsh-rea pattern). */
  function markRemoteMethod(Remote, prototype, method) {
    const decorator = Remote(method);
    decorator(undefined, {
      name: method,
      private: false,
      static: false,
      addInitializer(fn) {
        fn.call(Object.create(prototype));
      },
    });
  }

  async function mountRemote() {
    if (remoteMounted) return true;
    if (typeof ctx.reflect?.provide !== "function") return false;
    let protocol;
    try {
      protocol = await import("@deepseek-ai/dsh-typert-protocol");
    } catch {
      return false;
    }
    try {
      class PhononspeakRemote extends protocol.TypertRemoteService {
        constructor(context) {
          super(context, "phononspeak");
        }
        async ping(request) { return safe("ping", request); }
        async state(request) { return safe("state", request); }
        async config(request) { return safe("config", request); }
        async action(request) { return safe("action", request); }
        async presence(request) { return safe("presence", request); }
        async setup(request) { return safe("setup", request); }
        async setupStatus(request) { return safe("setupStatus", request); }
        async audio(request) { return safe("audio", request); }
      }
      const methods = ["ping", "state", "config", "action", "presence", "setup", "setupStatus", "audio"];
      for (const method of methods) markRemoteMethod(protocol.Remote, PhononspeakRemote.prototype, method);
      new PhononspeakRemote(ctx);
      remoteMounted = true;
      return true;
    } catch (error) {
      lastError = `RPC není dostupné: ${String(error?.message ?? error)}`;
      return false;
    }
  }

  async function safe(method, request) {
    try {
      return await handleRpc(method, request);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  const initialize = (async () => {
    await mkdir(dataDir, { recursive: true });
    await mkdir(audioDir, { recursive: true });
    await pruneStaleAudio();
    await loadSettings();
    publish();
    // The Typert package is present in every Web boot; if it is not, the UI
    // degrades to read-only instead of failing the load.
    await mountRemote();
    await refreshEngines({ quiet: true });

    // Out-of-the-box promise: the user should not have to find a model. If the
    // configured chain has nothing usable and the user allowed provisioning,
    // fetch the default engine in the background (once an hour at most, so an
    // offline machine is not hammered).
    if (config.autoProvision && settings.enabled) {
      const usable = pickEngine(settings.engine);
      const supertonic = engineStatuses.find((engine) => engine.id === "supertonic");
      const lastAttempt = Number(settings.provisionAttemptAt ?? 0);
      if (!supertonic?.available && usable === null && now() - lastAttempt > 3600_000) {
        settings.provisionAttemptAt = now();
        persistSettings();
        provision("supertonic").catch(() => {});
      }
    }

  })().catch((error) => {
    // A plugin must never take the Host down. 0.2.x turns an unhandled
    // rejection into a fatal load failure, so every failure is captured here.
    lastError = `Phononspeak se nepodařilo inicializovat: ${String(error?.message ?? error)}`;
    try {
      console.error("[phononspeak] init failed:", error);
    } catch {
      /* no console */
    }
  });

  // Tear down the worker, the audio route and any child process with the fiber.
  // Registered synchronously so it exists even if provisioning never finishes.
  ctx.effect(() => () => {
    disposed = true;
    cancelActive();
  });

  /* ---------------------------------------------------------------- routing */

  // The web server is part of the shipped web runtime, so it normally exists by
  // the time a bundle is composed. If it does not (a headless boot), retry
  // briefly instead of losing the whole UI to one race.
  let routeDispose = null;
  const registerRoutes = () => {
    if (routeDispose) return true;
    const webServer = ctx.get("webServer");
    if (!webServer) return false;
    try {
      routeDispose = webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler: handle });
      return true;
    } catch (error) {
      lastError = `HTTP cesta není dostupná: ${String(error?.message ?? error)}`;
      return false;
    }
  };
  try {
    registerRoutes();
  } catch {
    /* handled inside */
  }
  if (!routeDispose) {
    const retry = setInterval(() => {
      if (registerRoutes()) clearInterval(retry);
    }, 500);
    retry.unref?.();
    ctx.effect(() => () => clearInterval(retry));
  }
  ctx.effect(() => () => {
    if (routeDispose) routeDispose();
    routeDispose = null;
  });

  /* ------------------------------------------------------------------ tool */

  ctx.tools.register(defineTool({
    name: "dsh_phononspeak",
    description:
      "Speak a short text aloud to the user through the local Phononspeak voice channel. " +
      "Use action=summary to read a 1–3 sentence summary of your answer (Czech, max ~300 characters), " +
      "action=attention when you need the user at the computer (they are called out loud and notified), " +
      "action=speak for any other deliberate speech, action=stop to silence the queue, " +
      "action=status for the current configuration, action=voices for available voices, " +
      "action=install to provision an engine. NEVER narrate reasoning, progress or interim steps; " +
      "never read code, URLs or long lists. Keep every spoken message to one short paragraph.",
    parameters: {
      action: { type: "string", required: true, description: "summary | attention | question | speak | stop | status | state | voices | config | install | ack" },
      text: { type: "string", description: "Text to speak (summary/attention/speak). Czech, short." },
      voice: { type: "string", description: "Optional voice id from action=voices." },
      engine: { type: "string", description: "Optional engine id: supertonic | piper | pocket | say." },
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      try {
        await initialize;
        const result = await runAction(args ?? {});
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
      }
    },
  }));

  /* -------------------------------------------------------- prompt + events */

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: "phononspeak",
      order: 410,
      // Dynamic: the instruction exists only while the feature the user enabled
      // needs the model to do something. A silent plugin costs no tokens.
      text: () => {
        if (!settings.enabled) return "";
        const lines = [
          "Hlasový kanál (Phononspeak) je zapnutý. Nástroj dsh_phononspeak umí přečíst krátký text nahlas.",
          "Pravidla: mluv česky, krátce, jednou větou až odstavcem. Nikdy nepředčítej uvažování, průběžné kroky, kód, URL ani dlouhé seznamy.",
        ];
        if (settings.autoSummary) {
          lines.push(
            "Po každé dokončené odpovědi zavolej dsh_phononspeak action=summary s českým shrnutím své odpovědi v 1–3 větách (max ~300 znaků). Nezahrnuj do něj uvažování ani omluvy.",
          );
        } else {
          lines.push("Shrnutí čti pouze tehdy, když o to uživatel výslovně požádá.");
        }
        if (settings.commercialMode && !settings.allowPersonalVoice) {
          lines.push("Nepoužívej macOS hlas `say` (je licenčně jen pro osobní nekomerční použití).");
        }
        return lines.join(" ");
      },
    }));
  }

  // Approval and user questions are the two moments the agent truly needs the
  // user at the keyboard. Both are waterfalls: always pass control through.
  ctx.on("approval/request", (request, next) => {
    try {
      if (settings.enabled && !inQuietHours(settings)) {
        void runAction({ action: "attention", text: "Potřebuji od tebe schválení." }).catch(() => {});
      }
    } catch {
      /* never break the waterfall */
    }
    return next();
  });

  ctx.on("user-questions/request", (request, next) => {
    try {
      if (settings.enabled && !inQuietHours(settings)) {
        void runAction({ action: "attention", text: "Mám na tebe otázku. Potřebuji odpověď." }).catch(() => {});
      }
    } catch {
      /* never break the waterfall */
    }
    return next();
  });

  // Expose the live internals to other plugins the way dsh-video does, so a
  // future UI or a script can reuse the queue without re-implementing it.
  if (typeof ctx.provide === "function") {
    ctx.provide("dshPhononspeak", {
      paths,
      settings: () => ({ ...settings }),
      state: () => buildState(),
      speak: (text, options = {}) => enqueue({ kind: options.kind ?? "manual", text, priority: options.priority }),
      stop: stopAll,
    });
  }
}

export { apply, inject, name };
