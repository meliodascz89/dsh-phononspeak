//
//  engines.js — which voice can speak right now, and how to make it speak.
//
//  WHY THE LICENCE AND THE PRICE ARE PART OF THE ENGINE RECORD: the product is a
//  voice the user actually ships in their own work ("read the summary aloud" is
//  not a personal-use exemption). Two of the four engines cannot be used
//  commercially for the same reason — say's output is licensed for personal,
//  non-commercial content only — so "available" and "allowed" must never be the
//  same boolean. The Host gates on `commercial`/`personalOnly`; this file reports
//  them, and it refuses nothing on its own except at the point of synthesis, where
//  the caller has already been told what it is asking for.
//
//  Engine facts measured on this machine (2026-10-26):
//
//    supertonic  OpenRAIL-M   ONNX, 31 languages incl. cs, 10 voice styles.
//                             Model cache 380 MB, venv 160 MB, 44.1 kHz.
//                             Real numbers: 3.4 s of Czech in 2.2 s wall (RTF 0.65
//                             including model load), 4.8 s in 2.9 s (RTF 0.61).
//                             Does NOT expand Czech abbreviations; normalize.js does.
//    piper       GPL-3.0      engine binary is NOT on this machine's PATH; the
//                             cs voices (jirka, kasandra) ARE on disk. Called as a
//                             separate process only — never bundled.
//    pocket      CC-BY-4.0    438 MB model + ~1 GB venv (torch). Clones from wav.
//                             Runnable through the big chatterbox env; we provision
//                             our own venv so a fresh dataDir starts honest.
//    say         macOS SLA    always present; writes real RIFF/WAVE when asked for
//                             LEI16, but with a JUNK chunk first, so the WAV header
//                             is parsed by walking chunks, not by assuming 44 bytes.
//
//  WHY AVAILABILITY IS MEASURED WITH stat() ONLY: detectEngines runs on every
//  /state poll (once a second). Importing onnxruntime to answer "can you speak?"
//  would cost a second per poll. The markers written by provision.js are the
//  contract: a venv with `.installed-supertonic` really did finish pip, so its
//  presence is trustworthy enough for a status line, and a genuinely broken venv
//  still fails loudly at synthesize() time instead of lying here.
//

import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ENGINE_IDS } from "./contract.js";
import {
  enginePaths,
  ensureVenv,
  exists,
  downloadSupertonicModel,
  findPython,
  huggingFaceHubDirs,
  piperVoiceDirs,
  pocketSnapshot,
  progress,
  runProcess,
  supertonicCacheDir,
  supertonicModelReady,
  supertonicVoiceStyles,
  which,
} from "./provision.js";

/** Hard time limit for one synthesis, as promised to the Host. */
const SYNTH_TIMEOUT_MS = 60_000;

/** Supertonic speed range accepted by its CLI. */
const SUPERTONIC_SPEED = [0.7, 2.0];

/** Languages the shipped Supertonic-3 checkpoint declares (supertonic.cli). */
const SUPERTONIC_LANGUAGES = [
  "cs", "en", "ko", "ja", "ar", "bg", "da", "de", "el", "es",
  "et", "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv",
  "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk",
  "vi",
];

/**
 * Static catalogue, one record per contract ENGINE_IDS entry, in auto-chain
 * order. This is documentation for the UI and the licence gate; live facts
 * (installed? runtime path? which voices?) come from detectEngines.
 */
export const ENGINE_CATALOG = Object.freeze([
  Object.freeze({
    id: "supertonic",
    label: "Supertonic 3",
    license: "OpenRAIL-M",
    licenseUrl: "https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE",
    commercial: true,
    personalOnly: false,
    cloning: false,
    languages: Object.freeze([...SUPERTONIC_LANGUAGES]),
    sizeHint: "≈380 MB model + ~160 MB venv",
    notes:
      "Nejlepší komerčně čistá česká narace z těch, co jdou lokálně. ONNX, 10 stylů (F1–F5, M1–M5), 44,1 kHz. " +
      "Neklonuje a neumí streamovat; české zkratky nerozepisuje, proto se text posílá přes normalizeForSpeech.",
  }),
  Object.freeze({
    id: "piper",
    label: "Piper",
    license: "GPL-3.0 (engine) / voices CC0·CC-BY-4.0",
    licenseUrl: "https://github.com/OHF-Voice/piper1-gpl/blob/main/LICENSE.md",
    commercial: true,
    personalOnly: false,
    cloning: false,
    languages: Object.freeze(["cs", "en"]),
    sizeHint: "0 MB pluginem; hlasy ~60–80 MB (na tomto stroji už na disku)",
    notes:
      "Nejúspornější cesta (~50 MB RAM, >10× realtime). Engine je GPL-3.0, takže ho plugin nikdy nebalí — " +
      "volá ho jen jako samostatný proces. Binárka na tomto stroji v PATH není; hlasy jirka/kasandra ano.",
  }),
  Object.freeze({
    id: "pocket",
    label: "Pocket TTS Czech",
    license: "CC-BY-4.0",
    licenseUrl: "https://huggingface.co/vvolhejn/pocket-tts-czech",
    commercial: true,
    personalOnly: false,
    cloning: true,
    languages: Object.freeze(["cs"]),
    sizeHint: "≈438 MB model + ~1 GB venv (torch)",
    notes:
      "Jediná cesta ke klonování hlasu z wav. Trénink na parlamentních projevech = formální dospělý registr. " +
      "Šest vzorků v modelu jsou nahrávky reálných poslanců — CC-BY kryje nahrávku, ne osobnostní práva, " +
      "proto nejsou výchozí a vždy se označují.",
  }),
  Object.freeze({
    id: "say",
    label: "macOS Say",
    license: "Apple macOS SLA (personal use only)",
    licenseUrl: "https://www.apple.com/legal/sla/",
    commercial: false,
    personalOnly: true,
    cloning: false,
    languages: Object.freeze(["cs", "en"]),
    sizeHint: "0 MB (součást macOS)",
    notes:
      "Vždy po ruce, nulová instalace, ale licence macOS dovoluje výstup jen pro osobní, nekomerční obsah. " +
      "Host ho proto pouští jen s výslovným souhlasem (allowPersonalVoice). Český hlas: Zuzana.",
  }),
]);

/** True when `value` names an engine this plugin knows. */
export function isEngineId(value) {
  return typeof value === "string" && ENGINE_IDS.includes(value);
}

// ---------------------------------------------------------------------------
// engine-specific facts (shared by detect / listVoices / synthesize)
// ---------------------------------------------------------------------------

/** Readable Czech label for a Supertonic style id. */
function supertonicVoiceLabel(id) {
  if (/^M\d$/.test(id)) return `Mužský hlas ${id}`;
  if (/^F\d$/.test(id)) return `Ženský hlas ${id}`;
  return `Hlas ${id}`;
}

/** Supertonic voice records for the styles actually present on disk. */
async function supertonicVoices(env) {
  const styles = await supertonicVoiceStyles(supertonicCacheDir({ ...process.env, ...(env ?? {}) }));
  return styles.map((id) => ({
    id,
    label: supertonicVoiceLabel(id),
    engine: "supertonic",
    language: "cs",
    license: "OpenRAIL-M",
    cloning: false,
    note: "styl hlasu modelu Supertonic 3 (nejde o klon)",
  }));
}

/** Piper voices on disk, as records the caller can actually synthesize with. */
async function piperVoices(env = process.env) {
  const found = [];
  const seen = new Set();
  for (const dir of await piperVoiceDirs(env)) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".onnx")) continue;
      const id = entry.replace(/\.onnx$/, "");
      if (seen.has(id)) continue;
      const model = join(dir, entry);
      const config = `${model}.json`;
      if (!(await exists(config))) continue; // a model without its config cannot load
      const language = id.split("_")[0]?.toLowerCase() ?? "";
      if (language !== "cs" && language !== "en") continue; // Voice.language is cs|en
      seen.add(id);
      // "cs_CZ-jirka-medium": locale, dataset name, quality tier.
      const [locale = id, dataset = "", quality = ""] = id.split("-");
      const human = dataset.charAt(0).toUpperCase() + dataset.slice(1);
      const qualityCs = quality === "high" ? "vysoká kvalita" : quality === "low" ? "nízká kvalita" : "střední kvalita";
      found.push({
        id,
        label: `${human || id} (${locale}, ${qualityCs})`,
        engine: "piper",
        language,
        license: "CC0/CC-BY-4.0 (hlas)",
        cloning: false,
        note: `Piper hlas z ${model}`,
        model,
        config,
      });
    }
  }
  return found.sort((left, right) => left.id.localeCompare(right.id));
}

/** Pocket reference voices from the model snapshot (never a default). */
function pocketVoices(snapshot) {
  if (snapshot === null) return [];
  return snapshot.voices.map((voice) => ({
    id: voice.id,
    label: `Vzorek ${voice.id.replace(/^cs_[mf]_/, "").replace(/^./, (c) => c.toUpperCase())} (model)`,
    engine: "pocket",
    language: "cs",
    license: "CC-BY-4.0 (nahrávka)",
    cloning: true,
    sampleFile: voice.path,
    note:
      "Referenční nahrávka reálného poslance z ParCzech — licence CC-BY-4.0 kryje nahrávku, " +
      "ne osobnostní práva. Není výchozí hlas; pro klon použij vlastní vzorek.",
  }));
}

/** `say -v ?` parser state. The system voice list cannot change without a reboot. */
let sayVoiceCache = null;

/** Czech system voices, parsed from `say -v ?`. */
async function sayVoices() {
  if (sayVoiceCache !== null) return sayVoiceCache;
  const result = await runProcess("/usr/bin/say", ["-v", "?"], { timeoutMs: 5000 });
  if (result.code !== 0) {
    sayVoiceCache = [];
    return sayVoiceCache;
  }
  const voices = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    // "Zuzana (Premium)    cs_CZ    # Ahoj! Já jsem Zuzana."
    const match = /^(.+?)\s{2,}([a-z]{2,3}_[A-Z]{2})\s*(?:#.*)?$/.exec(line);
    if (match === null) continue;
    const name = match[1].trim();
    const locale = match[2];
    if (!locale.startsWith("cs_")) continue; // Czech-first; the rest stays out of the picker
    voices.push({
      id: name,
      label: `${name} (${locale})`,
      engine: "say",
      language: "cs",
      license: "Apple macOS SLA (jen osobní použití)",
      cloning: false,
      note: "Systémový hlas macOS: výstup jen pro osobní, nekomerční obsah.",
    });
  }
  if (voices.length > 0) sayVoiceCache = voices;
  return voices;
}

/** Resolved interpreter of one of the plugin's venvs, or null. */
function venvPython(paths, engineId) {
  const dir = engineId === "pocket" ? paths.venvPocket : paths.venvSupertonic;
  return join(dir, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
}

/** True when a venv carries the marker provision.js writes after a clean pip run. */
async function venvHasPackage(paths, engineId, packageName) {
  const dir = engineId === "pocket" ? paths.venvPocket : paths.venvSupertonic;
  return exists(join(dir, `.installed-${packageName}`));
}

/** An explicitly configured pocket interpreter (reusing a big external env). */
function externalPocketPython(env) {
  const value = env?.PHONONSPEAK_POCKET_PYTHON;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

/** Status record skeleton: catalogue facts plus the live fields this file owns. */
function status(record, patch) {
  return {
    ...record,
    available: false,
    installed: false,
    reason: null,
    runtime: null,
    voices: [],
    ...patch,
  };
}

/**
 * Status of every engine, measured. Never throws: a probe that fails becomes a
 * `reason`, because one broken engine must not blank the whole settings page.
 */
export async function detectEngines(context = {}) {
  const env = context.env ?? process.env;
  const paths = enginePaths(context.dataDir);
  const statuses = [];

  for (const record of ENGINE_CATALOG) {
    try {
      if (record.id === "supertonic") statuses.push(await detectSupertonic(record, paths, env));
      else if (record.id === "piper") statuses.push(await detectPiper(record, env));
      else if (record.id === "pocket") statuses.push(await detectPocket(record, paths, env));
      else statuses.push(await detectSay(record));
    } catch (error) {
      statuses.push(
        status(record, {
          reason: `Detekce selhala: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    }
  }
  return statuses;
}

/** Supertonic needs three independent things: venv, package, 380 MB of weights. */
async function detectSupertonic(record, paths, env) {
  const python = venvPython(paths, "supertonic");
  const cacheDir = supertonicCacheDir({ ...process.env, ...(env ?? {}) });
  const hasVenv = await exists(python);
  const hasPackage = await venvHasPackage(paths, "supertonic", "supertonic");
  const hasModel = await supertonicModelReady(cacheDir);
  const consoleScript = join(dirname(python), "supertonic");
  const hasCli = await exists(consoleScript);

  let reason = null;
  if (!hasVenv || !hasPackage) {
    reason = `Runtime není nainstalovaný (chybí ${paths.venvSupertonic}). Spusť zprovoznění enginu — pip install supertonic do vlastního venv.`;
  } else if (!hasModel) {
    reason = `Model není stažený (chybí ${join(cacheDir, "onnx", "tts.json")}). Zprovoznění ho stáhne (~380 MB).`;
  } else if (!hasCli) {
    reason = `Ve venv chybí spouštěč supertonic (${consoleScript}); přeinstaluj balíček.`;
  }

  return status(record, {
    available: reason === null,
    installed: hasVenv && hasModel,
    reason,
    runtime: hasVenv ? python : null,
    voices: hasModel ? await supertonicVoices(env) : [],
  });
}

/** Piper is "available" only when the binary AND at least one voice are present. */
async function detectPiper(record, env) {
  const configured = env?.PHONONSPEAK_PIPER;
  const binary = await which(
    typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : "piper",
    [join(homedir(), ".local", "bin")],
  );
  const voices = await piperVoices(env);

  let reason = null;
  if (binary === null) {
    reason =
      "Binárka piper není v PATH. Engine je GPL-3.0, takže ho plugin sám nestahuje ani nebalí — " +
      "nainstaluj ji ručně (nebo nastav PHONONSPEAK_PIPER na její cestu).";
  } else if (voices.length === 0) {
    reason =
      "V ~/.local/share/piper nejsou žádné hlasy (.onnx + .onnx.json). Stáhni český hlas " +
      "(cs_CZ-jirka-medium) a polož ho tam.";
  }

  return status(record, {
    available: reason === null,
    installed: voices.length > 0,
    reason,
    runtime: binary,
    voices,
  });
}

/** Pocket needs a runtime we provisioned (or an explicitly trusted external one). */
async function detectPocket(record, paths, env) {
  const snapshot = await pocketSnapshot(env);
  const ownPython = venvPython(paths, "pocket");
  const ownReady = (await exists(ownPython)) && (await venvHasPackage(paths, "pocket", "pocket-tts"));
  const external = externalPocketPython(env);
  const runtime = ownReady ? ownPython : external;
  const externalExists = external === null ? false : await exists(external);

  let reason = null;
  if (snapshot === null) {
    reason =
      "Model vvolhejn/pocket-tts-czech není na disku (hledám v HF cache). Zprovoznění ho stáhne (~438 MB).";
  } else if (runtime === null || (external !== null && !externalExists)) {
    reason =
      `Runtime pocket-tts není nainstalovaný (chybí ${paths.venvPocket}). Je to ~1 GB kvůli torchu; ` +
      "zprovoznění ho vytvoří. Kdo už velké prostředí má, může nastavit PHONONSPEAK_POCKET_PYTHON.";
  }

  return status(record, {
    available: reason === null,
    installed: snapshot !== null,
    reason,
    runtime: runtime !== null && (ownReady || externalExists) ? runtime : null,
    voices: pocketVoices(snapshot),
  });
}

/** `say` exists on every macOS and nowhere else. */
async function detectSay(record) {
  if (process.platform !== "darwin") {
    return status(record, {
      reason: "macOS `say` existuje jen na macOS — na této platformě ho nenajdu.",
    });
  }
  const binary = await which("/usr/bin/say");
  if (binary === null) {
    return status(record, { reason: "Binárka /usr/bin/say na tomto systému chybí." });
  }
  return status(record, {
    available: true,
    installed: true,
    runtime: binary,
    voices: await sayVoices(),
  });
}

// ---------------------------------------------------------------------------
// provisioning
// ---------------------------------------------------------------------------

/**
 * Make one engine ready to speak, or throw with a reason a human can act on.
 *
 * `piper` is the deliberate exception: its engine licence (GPL-3.0) and its
 * "bring your own binary" model mean the plugin must not download it, so
 * ensureEngine explains where to put it instead of pretending to install.
 */
export async function ensureEngine(engineId, context = {}) {
  if (!isEngineId(engineId)) {
    throw new Error(`Neznámý engine „${String(engineId)}". Znám: ${ENGINE_IDS.join(", ")}.`);
  }
  if (typeof context.dataDir !== "string" || context.dataDir.trim().length === 0) {
    throw new Error("Chybí dataDir — bez něj nevím, kam instalovat runtime.");
  }
  const paths = enginePaths(context.dataDir);
  await mkdir(paths.root, { recursive: true });

  if (engineId === "supertonic") {
    const python = await findPython(context);
    if (python === null) {
      throw new Error(
        "Nenašel jsem Python ≥ 3.10. Supertonic je Python balíček, takže bez něj neběží: " +
          "nainstaluj python3.12 (brew install python@3.12) nebo nastav PHONONSPEAK_PYTHON na existující interpreter.",
      );
    }
    progress(context, `Používám Python ${python}.`);
    const venvPythonPath = await ensureVenv("supertonic", python, ["supertonic"], context);
    await downloadSupertonicModel(venvPythonPath, context);
    return requireAvailable(await detectEngines(context), "supertonic");
  }

  if (engineId === "pocket") {
    const python = await findPython(context);
    if (python === null) {
      throw new Error(
        "Nenašel jsem Python ≥ 3.10. Pocket TTS je Python balíček s torch (~1 GB), takže bez Pythonu neběží.",
      );
    }
    progress(context, `Používám Python ${python}.`);
    const venvPythonPath = await ensureVenv("pocket", python, ["pocket-tts"], context);
    await downloadPocketModel(venvPythonPath, context);
    return requireAvailable(await detectEngines(context), "pocket");
  }

  if (engineId === "piper") {
    const current = requireStatus(await detectEngines(context), "piper");
    if (current.available) return current;
    throw new Error(
      `${current.reason ?? "Piper není k dispozici."} ` +
        "Hlasy už na disku jsou; chybí jen spustitelná binárka piper.",
    );
  }

  return requireAvailable(await detectEngines(context), "say");
}

/** Find one status by id; the catalogue guarantees it exists. */
function requireStatus(statuses, engineId) {
  const found = statuses.find((entry) => entry.id === engineId);
  if (found === undefined) throw new Error(`Engine „${engineId}" v katalogu chybí.`);
  return found;
}

/** Turn "still not ready after provisioning" into one actionable error. */
function requireAvailable(statuses, engineId) {
  const found = requireStatus(statuses, engineId);
  if (!found.available) {
    throw new Error(`Engine ${engineId} se nepodařilo zprovoznit: ${found.reason ?? "neznámý důvod"}`);
  }
  return found;
}

/**
 * Download the pocket model when the HF cache does not already have it.
 *
 * The snapshot is fetched through huggingface_hub (a pocket-tts dependency), so
 * the revision and the file list come from the model itself rather than from a
 * URL list maintained here.
 */
async function downloadPocketModel(venvPythonPath, context) {
  const env = context.env ?? process.env;
  const snapshot = await pocketSnapshot(env);
  if (snapshot !== null) {
    progress(context, `Model Pocket TTS Czech už je na disku (${snapshot.root}).`);
    return;
  }
  const hub = huggingFaceHubDirs(env)[0];
  progress(context, "Stahuji model Pocket TTS Czech (~438 MB) — jednorázově…");
  const result = await runProcess(
    venvPythonPath,
    [
      "-c",
      [
        "import os",
        "from huggingface_hub import snapshot_download",
        "from pathlib import Path",
        `snapshot_download(repo_id="vvolhejn/pocket-tts-czech", cache_dir=${JSON.stringify(hub)})`,
        "print('snapshot hotový')",
      ].join("\n"),
    ],
    {
      timeoutMs: 60 * 60_000,
      env: { ...env, HUGGINGFACE_HUB_CACHE: hub },
      signal: context.signal,
      onStdout: (line) => progress(context, `model: ${line.slice(0, 160)}`),
      onStderr: (line) => progress(context, `model: ${line.slice(0, 160)}`),
    },
  );
  if (result.spawnError !== null) {
    throw new Error(`Stahování modelu Pocket TTS nelze spustit: ${result.spawnError}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `Stahování modelu Pocket TTS selhalo (kód ${result.code}): ${(result.stderr || result.stdout).trim().slice(-500)}`,
    );
  }
  const after = await pocketSnapshot(env);
  if (after === null) {
    throw new Error(`Model Pocket TTS se nestáhl do ${hub} — chybí snapshots/*/czech.yaml.`);
  }
}

// ---------------------------------------------------------------------------
// voices
// ---------------------------------------------------------------------------

/**
 * Voices of one engine, or an empty list for an unknown/`auto` id.
 *
 * An empty list is the honest answer for "auto": the Host must resolve the chain
 * before it can talk about a voice. Throwing here would break the UI's periodic
 * refresh for a question that has no answer.
 */
export async function listVoices(engineId, context = {}) {
  if (!isEngineId(engineId)) return [];
  const statuses = await detectEngines(context);
  return requireStatus(statuses, engineId).voices;
}

// ---------------------------------------------------------------------------
// synthesis
// ---------------------------------------------------------------------------

/**
 * Speak one string. The returned `file` is the file the caller asked for (or the
 * default one under dataDir/audio), never a temp path that might be reaped.
 *
 * Every write happens inside dataDir; `outFile` is the only exception because the
 * caller named it. A temp file inside dataDir is synthesized first and moved into
 * place only after it parses as audio, so a killed child can never leave a
 * half-written wav at a path the Host will happily serve.
 *
 * @param {{
 *   engineId: string, text: string, voice?: string|null, language?: "cs"|"en",
 *   speed?: number, outFile?: string, dataDir?: string, env?: object,
 *   onProgress?: (message: string) => void, signal?: AbortSignal,
 *   voicePath?: string|null,
 * }} request
 * @returns {Promise<{file: string, engine: string, voice: string, ms: number,
 *   sampleRate: number, bytes: number}>}
 */
export async function synthesize(request = {}) {
  const engineId = request.engineId;
  if (!isEngineId(engineId)) {
    throw new Error(
      `Neznámý engine „${String(engineId)}". Použij jeden z: ${ENGINE_IDS.join(", ")}.`,
    );
  }
  const text = typeof request.text === "string" ? request.text.trim() : "";
  if (text.length === 0) {
    throw new Error("Není co číst — text pro syntézu je prázdný.");
  }
  if (text.length > 20000) {
    throw new Error(`Text je delší než limit (${text.length} znaků, max 20000). Zkrať ho v Hostu.`);
  }
  if (typeof request.dataDir !== "string" || request.dataDir.trim().length === 0) {
    throw new Error("Chybí dataDir — bez něj nevím, kam smím zapisovat.");
  }

  const paths = enginePaths(request.dataDir);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.audioDir, { recursive: true });
  const workDir = join(paths.root, "tmp");
  await mkdir(workDir, { recursive: true });

  const context = {
    dataDir: paths.root,
    env: request.env,
    onProgress: request.onProgress,
    signal: request.signal,
  };
  const engine = requireStatus(await detectEngines(context), engineId);
  if (!engine.available) {
    throw new Error(`Engine ${engineId} není připravený: ${engine.reason ?? "neznámý důvod"}`);
  }

  const voice = await resolveVoice(engineId, request, engine, context);
  const outFile = resolveOutFile(request.outFile, paths, engineId);
  await mkdir(dirname(outFile), { recursive: true });

  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempBase = join(workDir, `speech-${stamp}`);
  const tempOut = `${tempBase}.wav`;
  const tempText = `${tempBase}.txt`;
  const startedAt = Date.now();

  try {
    const language = request.language === "en" ? "en" : "cs";
    if (engineId === "supertonic") {
      await runSupertonic({ engine, text, voice, language, speed: request.speed, tempOut, context });
    } else if (engineId === "piper") {
      await runPiper({ engine, text, voice, speed: request.speed, tempOut, tempText, context });
    } else if (engineId === "pocket") {
      await runPocket({ engine, text, voice, tempOut, context });
    } else {
      await runSay({ engine, text, voice, speed: request.speed, tempOut, context });
    }

    let source = tempOut;
    let info = await readAudioInfo(tempOut);
    if (info === null || (await fileBytes(tempOut)) === 0) {
      throw new Error(`Syntéza (${engineId}) nevyrobila zvuk — soubor je prázdný nebo chybí.`);
    }
    if (info.container !== "wav") {
      const converted = await convertToWav(tempOut, context);
      source = converted.path;
      info = converted.info;
      await rm(converted.path, { force: true }).catch(() => {});
    }

    await moveInto(source, outFile);
    const bytes = await fileBytes(outFile);
    return {
      file: outFile,
      engine: engineId,
      voice,
      ms: Date.now() - startedAt,
      sampleRate: info.sampleRate,
      bytes,
    };
  } finally {
    await rm(tempOut, { force: true }).catch(() => {});
    await rm(tempText, { force: true }).catch(() => {});
  }
}

/**
 * Pick the voice id to hand to the engine.
 *
 * Pocket is the strict case: it needs a reference wav, its shipped wavs are
 * recordings of real people, and silently falling back to one would put a
 * stranger's voice in the user's summary. So pocket with no explicit voice is an
 * error, not a default.
 */
async function resolveVoice(engineId, request, engine, context) {
  const requested = typeof request.voice === "string" && request.voice.trim().length > 0 ? request.voice.trim() : null;

  if (engineId === "pocket") {
    const explicitPath = typeof request.voicePath === "string" && request.voicePath.trim().length > 0
      ? request.voicePath.trim()
      : null;
    if (explicitPath !== null) {
      if (!(await exists(explicitPath))) {
        throw new Error(`Hlasový vzorek pro pocket neexistuje: ${explicitPath}`);
      }
      return explicitPath;
    }
    const fromModel = engine.voices.find((entry) => entry.id === requested);
    if (fromModel !== undefined && typeof fromModel.sampleFile === "string") return fromModel.sampleFile;
    const ownSample = requested === null ? null : join(enginePaths(context.dataDir).voicesDir, `${requested}.wav`);
    if (ownSample !== null && (await exists(ownSample))) return ownSample;
    throw new Error(
      requested === null
        ? "Pocket TTS potřebuje hlasový vzor (voicePath na vlastní wav). Vzorky v modelu jsou nahrávky reálných poslanců, " +
            "takže se jako výchozí hlas záměrně nepoužívají."
        : `Pocket TTS nezná hlas „${requested}" — není mezi vzorky modelu ani v ${enginePaths(context.dataDir).voicesDir}.`,
    );
  }

  if (engineId === "piper") {
    if (requested === null) {
      const czech = engine.voices.find((entry) => entry.language === "cs") ?? engine.voices[0];
      if (czech === undefined) throw new Error("Piper nemá žádný hlas k použití.");
      return czech.id;
    }
    if (!engine.voices.some((entry) => entry.id === requested)) {
      throw new Error(
        `Piper hlas „${requested}" nezná. Dostupné: ${engine.voices.map((entry) => entry.id).join(", ")}.`,
      );
    }
    return requested;
  }

  if (engineId === "say") {
    if (requested === null) return "Zuzana";
    if (!engine.voices.some((entry) => entry.id === requested)) {
      throw new Error(
        `Systémový hlas „${requested}" mezi českými hlasy není. Dostupné: ${engine.voices.map((entry) => entry.id).join(", ")}.`,
      );
    }
    return requested;
  }

  if (requested === null) return engine.voices.some((entry) => entry.id === "M1") ? "M1" : (engine.voices[0]?.id ?? "M1");
  if (!engine.voices.some((entry) => entry.id === requested)) {
    throw new Error(
      `Supertonic hlas „${requested}" nezná. Dostupné: ${engine.voices.map((entry) => entry.id).join(", ")}.`,
    );
  }
  return requested;
}

/** Absolute output path; a relative one is resolved *inside* dataDir. */
function resolveOutFile(outFile, paths, engineId) {
  if (typeof outFile === "string" && outFile.trim().length > 0) {
    const value = outFile.trim();
    return isAbsolute(value) ? value : resolve(paths.root, value);
  }
  return join(paths.audioDir, `${engineId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
}

/** Shared child-process handling for all four engines. */
async function runEngine(file, args, cwd, context, label) {
  progress(context, `Spouštím ${label}…`);
  const result = await runProcess(file, args, {
    cwd,
    timeoutMs: SYNTH_TIMEOUT_MS,
    env: context.env,
    signal: context.signal,
  });
  if (result.aborted) throw new Error("Syntéza byla přerušena (stop).");
  if (result.timedOut) throw new Error(`Syntéza (${label}) překročila ${SYNTH_TIMEOUT_MS / 1000} s a byla ukončena.`);
  if (result.spawnError !== null) throw new Error(`Nepodařilo se spustit ${label}: ${result.spawnError}`);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-5).join(" ");
    throw new Error(`Syntéza (${label}) selhala (kód ${result.code}): ${detail.slice(-400)}`);
  }
  return result;
}

/** Supertonic 3 via its CLI; `--` keeps a summary starting with "-" from parsing as a flag. */
async function runSupertonic({ engine, text, voice, language, speed, tempOut, context }) {
  const python = engine.runtime;
  const consoleScript = join(dirname(python), "supertonic");
  const lang = SUPERTONIC_LANGUAGES.includes(language) ? language : "na";
  const rate = clampSpeed(speed, SUPERTONIC_SPEED[0], SUPERTONIC_SPEED[1], 1.0);
  const args = [
    "tts",
    "--lang", lang,
    "--voice", voice,
    "--speed", String(rate),
    "--steps", "8",
    "-o", tempOut,
    "--",
    text,
  ];
  await runEngine(consoleScript, args, dirname(tempOut), context, "Supertonic 3");
}

/** Piper via its CLI. Text goes through a file because `spawn` owns stdin weakly. */
async function runPiper({ engine, text, voice, speed, tempOut, tempText, context }) {
  const chosen = engine.voices.find((entry) => entry.id === voice);
  if (chosen === undefined) throw new Error(`Piper hlas „${voice}" není na disku.`);
  await writeFile(tempText, `${text}\n`, "utf8");
  const base = ["--model", chosen.model, "--output_file", tempOut, "--input_file", tempText];
  const rate = clampSpeed(speed, 0.5, 2.0, 1.0);
  // `--length_scale` is the long-standing C++ CLI spelling; the Python 1.3 CLI
  // accepts `--length-scale`. We try the C++ form and fall back once without any
  // speed flag, because a failed flag must not fail the sentence.
  const withSpeed = rate === 1.0 ? base : [...base, "--length_scale", String(1 / rate)];
  try {
    await runEngine(engine.runtime, withSpeed, dirname(tempOut), context, "Piper");
  } catch (error) {
    if (rate === 1.0) throw error;
    progress(context, "Piper nepřijal přepínač rychlosti — syntetizuji bez něj.");
    await runEngine(engine.runtime, base, dirname(tempOut), context, "Piper");
  }
}

/** Pocket TTS Czech; it has no speed knob, so `speed` is ignored here. */
async function runPocket({ engine, text, voice, tempOut, context }) {
  const snapshot = await pocketSnapshot(context.env ?? process.env);
  if (snapshot === null) throw new Error("Model Pocket TTS Czech není na disku.");
  const args = [
    "-m", "pocket_tts", "generate",
    "--config", snapshot.config,
    "--voice", voice,
    "--text", text,
    "--output-path", tempOut,
    "-q",
  ];
  await runEngine(engine.runtime, args, dirname(tempOut), context, "Pocket TTS");
}

/** macOS `say`, asked for 22.05 kHz mono WAV directly. */
async function runSay({ engine, text, voice, speed, tempOut, context }) {
  const wordsPerMinute = Math.round(175 * clampSpeed(speed, 0.6, 3.0, 1.0));
  const base = ["-v", voice, "-r", String(wordsPerMinute), "-o", tempOut];
  try {
    await runEngine(
      engine.runtime,
      [...base, "--data-format=LEI16@22050", "--", text],
      dirname(tempOut),
      context,
      "macOS say",
    );
  } catch (error) {
    // Older systems refuse the data format; a plain file is then AIFF and gets
    // normalised by ffmpeg below. Losing the format must not lose the sentence.
    if (context.signal?.aborted === true) throw error;
    progress(context, "say nepřijal formát LEI16 — zkouším výchozí výstup.");
    await runEngine(engine.runtime, [...base, "--", text], dirname(tempOut), context, "macOS say");
  }
}

/** Clamp a user-supplied speed into what an engine actually accepts. */
function clampSpeed(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// ---------------------------------------------------------------------------
// audio inspection
// ---------------------------------------------------------------------------

/** Size in bytes, or 0 when the file is missing. */
async function fileBytes(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Read the container facts of an audio file by walking WAV chunks.
 *
 * WHY NOT "sampleRate = readUInt32LE(24)": macOS `say` writes a JUNK padding chunk
 * before `fmt ` (verified on this machine), so the canonical 44-byte assumption
 * reads a mid-air offset. Walking chunks takes twenty lines and is right for every
 * writer we use (supertonic, piper, pocket, say, ffmpeg).
 */
async function readAudioInfo(file) {
  let handle = null;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.length < 12) return { container: "unknown", sampleRate: 0, channels: 0, bitsPerSample: 0, dataBytes: 0 };

    const magic = head.toString("ascii", 0, 4);
    const form = head.toString("ascii", 8, 12);
    if (magic === "FORM" && (form === "AIFF" || form === "AIFC")) {
      return { container: "aiff", sampleRate: 0, channels: 0, bitsPerSample: 0, dataBytes: 0 };
    }
    if (magic !== "RIFF" || form !== "WAVE") {
      return { container: "unknown", sampleRate: 0, channels: 0, bitsPerSample: 0, dataBytes: 0 };
    }

    const info = { container: "wav", sampleRate: 0, channels: 0, bitsPerSample: 0, dataBytes: 0 };
    let offset = 12;
    while (offset + 8 <= head.length) {
      const id = head.toString("ascii", offset, offset + 4);
      const size = head.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === "fmt " && body + 16 <= head.length) {
        info.channels = head.readUInt16LE(body + 2);
        info.sampleRate = head.readUInt32LE(body + 4);
        info.bitsPerSample = head.readUInt16LE(body + 14);
      } else if (id === "data") {
        info.dataBytes = size;
        break; // the payload is the rest of the file; nothing after it matters
      }
      if (size === 0 || size > head.length || body + size > head.length) break;
      offset = body + size + (size % 2);
    }
    if (info.sampleRate === 0) {
      // Last resort: the canonical PCM layout, for a writer that put `data` first.
      info.channels = info.channels === 0 ? head.readUInt16LE(22) : info.channels;
      info.sampleRate = head.readUInt32LE(24);
      info.bitsPerSample = info.bitsPerSample === 0 ? head.readUInt16LE(34) : info.bitsPerSample;
    }
    return info;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Convert a non-WAV engine output to WAV when ffmpeg is present.
 *
 * The only realistic case is `say` on a system that rejected the WAV data format.
 * Without ffmpeg we accept the file and report sampleRate 0 — a paused, playing
 * file beats a refused sentence, and the Host shows the unknown rate.
 */
async function convertToWav(file, context) {
  const empty = { container: "unknown", sampleRate: 0, channels: 0, bitsPerSample: 0, dataBytes: 0 };
  const ffmpeg = await which("ffmpeg");
  if (ffmpeg === null) {
    progress(context, "ffmpeg není k dispozici — nechávám původní formát a hlásím sampleRate 0.");
    return { path: file, info: empty };
  }
  const target = `${file}.conv.wav`;
  const result = await runProcess(
    ffmpeg,
    ["-hide_banner", "-nostdin", "-y", "-i", file, "-c:a", "pcm_s16le", target],
    { timeoutMs: SYNTH_TIMEOUT_MS, env: context.env, signal: context.signal },
  );
  if (result.code !== 0) {
    throw new Error(`Převod zvuku na WAV selhal: ${(result.stderr || result.stdout).trim().slice(-300)}`);
  }
  const info = await readAudioInfo(target);
  return { path: target, info: info ?? empty };
}

/** Move a finished temp file into place, across volumes if needed. */
async function moveInto(temp, target) {
  try {
    await rename(temp, target);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }
  await copyFile(temp, target);
  await rm(temp, { force: true }).catch(() => {});
}

/** Exported for tests only: the WAV facts of a file, without synthesizing. */
export async function inspectAudio(file) {
  if (typeof file !== "string") throw new Error("inspectAudio potřebuje cestu k souboru.");
  return readAudioInfo(file);
}
