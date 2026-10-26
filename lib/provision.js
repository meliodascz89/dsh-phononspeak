//
//  provision.js — everything about *getting* a voice onto this machine.
//
//  WHY THIS IS SEPARATE FROM engines.js: "is the engine ready?" and "make the
//  engine ready" are different questions with different failure modes. Detection
//  must be cheap, synchronous enough to run on every /state poll and never throw;
//  provisioning is slow, touches the network, must report progress and may fail
//  hard. Mixing them produces a detect function that silently starts a 380 MB
//  download because a caller asked "what can you do?".
//
//  WHY PYTHON IS DISCOVERED AND VERIFIED, NOT ASSUMED: the first `python3` on
//  this machine's PATH is a pyenv shim that answers 3.8, and the Supertonic wheel
//  needs >= 3.9 with an onnxruntime wheel for the exact interpreter. Picking the
//  wrong one produces a venv that builds half a dependency tree and then fails
//  with a linker error — after the user waited two minutes. So every candidate is
//  asked for its version and rejected *before* any venv is created.
//
//  WHY MARKER FILES: `pip install` on an unchanged venv is still a network round
//  trip plus a resolver run. The Host calls ensureEngine on every settings save
//  and every "wake the engine" click; without markers that is a request per click.
//  A marker is written only after pip exits zero, so a failed install cannot look
//  finished.
//
//  WHY THE MODEL CACHE IS SHARED (~/.cache/supertonic3): the 380 MB of ONNX
//  weights do not depend on which plugin directory asked for them. Downloading
//  them per dataDir would burn 380 MB for every test directory. The plugin owns
//  its venvs (those are cheap and version-pinned) but not the shared model cache,
//  and it honours SUPERTONIC_CACHE_DIR so the CLI and the detector cannot disagree
//  about where "the cache" is.
//

import { spawn } from "node:child_process";
import { access, chmod, constants, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** Minimum interpreter the Supertonic and pocket wheels support for us. */
const PYTHON_MIN = [3, 10];

/**
 * Candidates in the order that gets a working interpreter fastest. The bare
 * `python3` is last on purpose: on this machine it is Python 3.8.
 */
const PYTHON_CANDIDATES = [
  "python3.13",
  "python3.12",
  "python3.11",
  "/opt/homebrew/bin/python3.12",
  "/opt/homebrew/bin/python3.11",
  "/usr/local/bin/python3.12",
  "python3",
];

/** Directories that Homebrew/system installs live in but PATH may omit. */
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Harness-wide AI root, the convention dsh-video already uses on this machine. */
const HARNESS_AI_ROOT = "/Volumes/KvaDisk/HarnessAI";

/** Pocket TTS Czech repository, as published. */
export const POCKET_REPO = "vvolhejn/pocket-tts-czech";

// ---------------------------------------------------------------------------
// small, shared primitives
// ---------------------------------------------------------------------------

/** Expand a leading `~` the way the shell would; everything else is literal. */
function expandHome(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

/** Where the venv's executables live on this platform. */
function binDir() {
  return process.platform === "win32" ? "Scripts" : "bin";
}

/** Absolute path of the interpreter inside a venv directory. */
function venvPythonPath(venvDir) {
  return join(venvDir, binDir(), process.platform === "win32" ? "python.exe" : "python");
}

/** True when `path` exists (any type). Never throws. */
export async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` is a file and has at least one byte. */
async function isNonEmptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve an executable through PATH (plus a few well-known directories).
 *
 * WHY NOT A SHELL: the plugin runs inside the Host with no shell guarantees, and
 * a shell adds a quoting surface for a value we do not control. Scanning PATH is
 * exact and cannot be tricked by a filename containing a semicolon.
 */
export async function which(name, extraDirs = []) {
  if (typeof name !== "string" || name.length === 0) return null;
  if (isAbsolute(name) || name.startsWith("~/")) {
    const absolute = isAbsolute(name) ? name : expandHome(name);
    try {
      await access(absolute, constants.X_OK);
      return absolute;
    } catch {
      return null;
    }
  }
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs, ...FALLBACK_DIRS].filter(
    (dir) => typeof dir === "string" && dir.length > 0,
  );
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Run one child process without a shell, with a timeout and abort support.
 *
 * Resolves for every outcome, including a missing binary and a non-zero exit:
 * callers decide what is fatal. `signal` kills the process, which is how "stop
 * talking" works all the way down into the TTS engine.
 *
 * @returns {Promise<{code:number, signal:string|null, stdout:string, stderr:string,
 *   timedOut:boolean, aborted:boolean, spawnError:string|null, truncated:boolean,
 *   ms:number}>}
 */
export function runProcess(file, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 30_000,
    signal,
    maxBuffer = 4 * 1024 * 1024,
    onStdout,
    onStderr,
  } = options;

  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let stdout = "";
    let stderr = "";
    let timer = null;
    let child = null;

    const finish = (code, signalName, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (signal !== undefined && signal !== null) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // a non-EventTarget signal is the caller's problem; nothing to clean
        }
      }
      resolvePromise({
        code: typeof code === "number" ? code : -1,
        signal: signalName ?? null,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnError: spawnError ?? null,
        truncated,
        ms: Date.now() - startedAt,
      });
    };

    const kill = () => {
      if (child === null) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };

    const onAbort = () => {
      aborted = true;
      kill();
    };

    const append = (chunk, which) => {
      const text = chunk.toString("utf8");
      const current = which === "out" ? stdout : stderr;
      if (current.length + text.length > maxBuffer) {
        truncated = true;
        if (which === "out") stdout += text.slice(0, Math.max(0, maxBuffer - current.length));
        else stderr += text.slice(0, Math.max(0, maxBuffer - current.length));
        return;
      }
      if (which === "out") stdout += text;
      else stderr += text;
    };

    try {
      child = spawn(file, args, {
        cwd,
        env: env === undefined ? process.env : { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish(-1, null, error instanceof Error ? error.message : String(error));
      return;
    }

    child.on("error", (error) => {
      finish(-1, null, error instanceof Error ? error.message : String(error));
    });
    child.stdout?.on("data", (chunk) => {
      append(chunk, "out");
      if (typeof onStdout === "function") {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line.trim().length > 0) onStdout(line.trim());
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      append(chunk, "err");
      if (typeof onStderr === "function") {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line.trim().length > 0) onStderr(line.trim());
        }
      }
    });
    child.on("close", (code, signalName) => finish(code, signalName, null));

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    if (signal !== undefined && signal !== null) {
      if (signal.aborted === true) {
        aborted = true;
        kill();
      } else if (typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

/** Call an onProgress callback without letting a broken callback break provisioning. */
export function progress(context, message) {
  const callback = context?.onProgress;
  if (typeof callback !== "function") return;
  try {
    callback(message);
  } catch {
    // progress reporting is telemetry, never control flow
  }
}

/** Throw early when a caller forgot the one directory provisioning writes to. */
function requireDataDir(context) {
  const dataDir = context?.dataDir;
  if (typeof dataDir !== "string" || dataDir.trim().length === 0) {
    throw new Error("Chybí dataDir — bez něj nevím, kam instalovat runtime a ukládat zvuk.");
  }
  return resolve(expandHome(dataDir));
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** The shared Supertonic model cache; SUPERTONIC_CACHE_DIR wins, as in the CLI. */
export function supertonicCacheDir(env = process.env) {
  const override = expandHome(env?.SUPERTONIC_CACHE_DIR);
  return override ?? join(homedir(), ".cache", "supertonic3");
}

/**
 * Every directory that could hold a HuggingFace hub, best first. The Harness AI
 * root comes before ~/.cache because that is where this machine's 438 MB pocket
 * snapshot already lives and re-downloading it would be pure waste.
 */
export function huggingFaceHubDirs(env = process.env) {
  const dirs = [];
  const push = (value) => {
    const path = expandHome(value);
    if (path !== null && !dirs.includes(path)) dirs.push(path);
  };
  push(env?.PHONONSPEAK_HF_HUB);
  push(env?.HUGGINGFACE_HUB_CACHE);
  push(env?.HF_HUB_CACHE);
  if (env?.HF_HOME) push(join(expandHome(env.HF_HOME), "hub"));
  push(join(env?.HARNESS_AI ?? HARNESS_AI_ROOT, "models", "huggingface", "hub"));
  push(join(homedir(), ".cache", "huggingface", "hub"));
  return dirs;
}

/**
 * Plugin-owned layout under `dataDir`.
 *
 * `cache` is deliberately *not* under dataDir: see the header. Everything the
 * plugin writes itself (venv, audio, cloned voice samples) is here, so deleting
 * one directory is a complete uninstall.
 */
export function enginePaths(dataDir) {
  const root = resolve(expandHome(dataDir) ?? join(homedir(), ".dsh", "phononspeak"));
  return {
    root,
    bin: join(root, "bin"),
    venvSupertonic: join(root, "venv-supertonic"),
    venvPocket: join(root, "venv-pocket"),
    cache: supertonicCacheDir(process.env),
    voicesDir: join(root, "voices"),
    audioDir: join(root, "audio"),
    settingsFile: join(root, "settings.json"),
  };
}

// ---------------------------------------------------------------------------
// python
// ---------------------------------------------------------------------------

/**
 * Ask one interpreter for its major.minor version. Returns null when the path is
 * not a working Python (a pyenv shim that has no version installed, a script
 * named python3 that is not Python, a broken symlink).
 */
async function pythonVersion(pythonPath, context = {}) {
  const result = await runProcess(
    pythonPath,
    ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
    { timeoutMs: 10_000, env: context.env },
  );
  if (result.code !== 0) return null;
  const match = /^\s*(\d+)\.(\d+)\s*$/.exec(result.stdout);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2])];
}

/**
 * First working interpreter with Supertonic-grade wheels.
 *
 * Honours `env.PHONONSPEAK_PYTHON` first so a user with a managed Python can pin
 * it, then the versioned Homebrew interpreters, then bare `python3` only if it is
 * new enough. Rejecting 3.8 out loud matters: silently falling through to a
 * different interpreter would make the failure appear later, inside pip.
 */
export async function findPython(context = {}) {
  const env = context.env ?? {};
  const candidates = [];
  const override = expandHome(env.PHONONSPEAK_PYTHON);
  if (override !== null) candidates.push(override);
  candidates.push(...PYTHON_CANDIDATES);

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = await which(candidate);
    if (resolved === null || seen.has(resolved)) continue;
    seen.add(resolved);
    const version = await pythonVersion(resolved, context);
    if (version === null) continue;
    const [major, minor] = version;
    if (major < PYTHON_MIN[0] || (major === PYTHON_MIN[0] && minor < PYTHON_MIN[1])) {
      progress(
        context,
        `Přeskakuji ${resolved} — je to Python ${major}.${minor}, potřebuji ≥ ${PYTHON_MIN.join(".")}.`,
      );
      continue;
    }
    return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// venv + pip
// ---------------------------------------------------------------------------

/** Marker filename for one package; version specifiers are stripped. */
function markerName(packageSpec) {
  const bare = String(packageSpec).split(/[<>=!~\[;@\s]/)[0] ?? String(packageSpec);
  return `.installed-${bare.replace(/[^a-z0-9._-]/gi, "-").toLowerCase()}`;
}

/** Validate the venv name so a caller cannot steer provisioning outside dataDir. */
function safeVenvName(name) {
  const value = String(name ?? "").trim();
  if (!/^[a-z][a-z0-9-]{0,30}$/i.test(value)) {
    throw new Error(`Neplatné jméno venv „${name}" — povolená jsou jen písmena, číslice a pomlčka.`);
  }
  return value.toLowerCase();
}

/** Keep only plausible pip requirement strings; reject the rest loudly. */
function normalizePackages(packages) {
  const list = Array.isArray(packages) ? packages : packages === undefined ? [] : [packages];
  const cleaned = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw new Error(`Balíček pro pip musí být řetězec, dostal jsem ${typeof entry}.`);
    }
    const value = entry.trim();
    if (value.length === 0) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+@/\[\]=<>!~,-]*$/.test(value)) {
      throw new Error(`Neplatný zápis balíčku „${value}" — pip dostane jen jméno a verzi.`);
    }
    if (!cleaned.includes(value)) cleaned.push(value);
  }
  return cleaned;
}

/** Directory of the venv for a known engine name (supertonic, pocket, …). */
function venvDirectory(name, dataDir) {
  const paths = enginePaths(dataDir);
  if (name === "supertonic") return paths.venvSupertonic;
  if (name === "pocket") return paths.venvPocket;
  return join(paths.root, `venv-${name}`);
}

/**
 * Create (or reuse) a venv and install `packages` into it. Returns the venv's
 * interpreter path.
 *
 * A venv that exists but lacks a marker is *repaired*, not recreated: deleting a
 * 160 MB (or 1 GB, for pocket) directory because one marker file is missing would
 * make a transient pip failure feel like a full reinstall.
 */
export async function ensureVenv(name, pythonPath, packages, context = {}) {
  const dataDir = requireDataDir(context);
  const safeName = safeVenvName(name);
  if (typeof pythonPath !== "string" || pythonPath.length === 0) {
    throw new Error(`Nemám Python pro venv „${safeName}" — nejdřív zjisti interpreter přes findPython().`);
  }
  const wanted = normalizePackages(packages);
  const venvDir = venvDirectory(safeName, dataDir);
  const python = venvPythonPath(venvDir);

  await mkdir(dirname(venvDir), { recursive: true });

  const installedMarkers = [];
  for (const spec of wanted) {
    if (await isNonEmptyFile(join(venvDir, markerName(spec)))) installedMarkers.push(spec);
  }
  const venvReady = await exists(python);
  if (venvReady && installedMarkers.length === wanted.length) {
    progress(context, `Prostředí ${safeName} je už připravené (${joinList(wanted)}).`);
    return python;
  }

  if (!venvReady) {
    progress(context, `Vytvářím virtuální prostředí ${safeName} (${pythonPath})…`);
    const created = await runProcess(pythonPath, ["-m", "venv", venvDir], {
      timeoutMs: 5 * 60_000,
      env: context.env,
      signal: context.signal,
    });
    if (created.spawnError !== null) {
      throw new Error(`Nepodařilo se spustit ${pythonPath}: ${created.spawnError}`);
    }
    if (created.aborted) {
      throw new Error(`Vytváření prostředí ${safeName} bylo přerušeno.`);
    }
    if (created.code !== 0 || !(await exists(python))) {
      await rm(venvDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `Vytvoření venv ${safeName} selhalo (kód ${created.code}): ${tail(created.stderr || created.stdout, 400)}`,
      );
    }
    // Some venv implementations land without the exec bit when copied around.
    await chmod(python, 0o755).catch(() => {});
  }

  const missing = wanted.filter((spec) => !installedMarkers.includes(spec));
  if (missing.length > 0) {
    await pipInstall(python, missing, context);
    for (const spec of missing) {
      await writeFile(
        join(venvDir, markerName(spec)),
        `${spec} instalováno ${new Date().toISOString()}\n`,
        "utf8",
      );
    }
  }
  return python;
}

/**
 * `pip install` with pip's own output streamed to onProgress.
 *
 * `--quiet` keeps pip's wall of "Requirement already satisfied" lines off the UI;
 * the meaningful milestones ("Collecting torch", "Installing collected
 * packages") still come through, and we add our own before/after lines. A failing
 * install reports the tail of stderr, because pip's actual reason is always in the
 * last few lines, never in its first.
 */
export async function pipInstall(venvPython, packages, context = {}) {
  const list = normalizePackages(packages);
  if (list.length === 0) return;
  progress(context, `Instaluji ${joinList(list)} — první běh může trvat minuty…`);

  const result = await runProcess(
    venvPython,
    ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "--upgrade", ...list],
    {
      timeoutMs: 30 * 60_000,
      env: context.env,
      signal: context.signal,
      onStdout: (line) => progress(context, `pip: ${shorten(line, 160)}`),
      onStderr: (line) => progress(context, `pip: ${shorten(line, 160)}`),
    },
  );

  if (result.spawnError !== null) {
    throw new Error(`pip se nepodařilo spustit (${venvPython}): ${result.spawnError}`);
  }
  if (result.aborted) throw new Error("Instalace balíčků byla přerušena.");
  if (result.timedOut) throw new Error("Instalace balíčků překročila 30 minut a byla ukončena.");
  if (result.code !== 0) {
    throw new Error(
      `pip install ${joinList(list)} selhal (kód ${result.code}): ${tail(result.stderr || result.stdout, 500)}`,
    );
  }
  progress(context, `Hotovo: ${joinList(list)} je nainstalováno.`);
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

/**
 * A Supertonic model is "downloaded" when the config and the voice styles are
 * both on disk. The config alone can exist from an interrupted download, and a
 * model without styles can synthesize only one hard-coded voice.
 */
export async function supertonicModelReady(cacheDir = supertonicCacheDir()) {
  if (!(await isNonEmptyFile(join(cacheDir, "onnx", "tts.json")))) return false;
  return (await supertonicVoiceStyles(cacheDir)).length > 0;
}

/** Voice style ids present on disk (F1–F5, M1–M5 on a full download). */
export async function supertonicVoiceStyles(cacheDir = supertonicCacheDir()) {
  try {
    const entries = await readdir(join(cacheDir, "voice_styles"));
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Download the Supertonic-3 weights through the installed package itself.
 *
 * WHY THROUGH THE PACKAGE AND NOT A HAND-WRITTEN HF FETCH: the package pins the
 * repository revision, so a hand-rolled download could silently pair new weights
 * with an old runtime. The CLI's `download` subcommand is the supported path; the
 * `python -c` fallback covers an install whose console script is missing (pip
 * `--user` style layouts).
 */
export async function downloadSupertonicModel(venvPython, context = {}) {
  const dataDir = requireDataDir(context);
  const paths = enginePaths(dataDir);
  // context.env must win over the ambient environment, exactly as it does in the CLI child.
  const cacheDir = supertonicCacheDir({ ...process.env, ...(context.env ?? {}) });

  if (await supertonicModelReady(cacheDir)) {
    progress(context, `Model Supertonic 3 už je v mezipaměti (${cacheDir}).`);
    return;
  }

  progress(context, "Stahuji model Supertonic 3 (~380 MB) — jednorázově…");
  const env = { ...(context.env ?? {}), SUPERTONIC_CACHE_DIR: cacheDir };
  const consoleScript = join(dirname(venvPython), "supertonic");
  const hasScript = await isNonEmptyFile(consoleScript);
  const file = hasScript ? consoleScript : venvPython;
  const args = hasScript
    ? ["download"]
    : [
        "-c",
        "from supertonic.loader import download_model, get_cache_dir; download_model(get_cache_dir())",
      ];

  const result = await runProcess(file, args, {
    timeoutMs: 60 * 60_000,
    env,
    signal: context.signal,
    onStdout: (line) => progress(context, `model: ${shorten(line, 160)}`),
    onStderr: (line) => progress(context, `model: ${shorten(line, 160)}`),
  });

  if (result.spawnError !== null) {
    throw new Error(`Stahování modelu Supertonic nelze spustit: ${result.spawnError}`);
  }
  if (result.aborted) throw new Error("Stahování modelu Supertonic bylo přerušeno.");
  if (result.timedOut) throw new Error("Stahování modelu Supertonic překročilo hodinu a bylo ukončeno.");
  if (result.code !== 0) {
    throw new Error(
      `Stahování modelu Supertonic selhalo (kód ${result.code}): ${tail(result.stderr || result.stdout, 500)}`,
    );
  }
  if (!(await supertonicModelReady(cacheDir))) {
    throw new Error(
      `Model Supertonic se nestáhl do ${cacheDir} (chybí onnx/tts.json nebo voice_styles/). ` +
        "Zkontroluj síť a volné místo; opakovaný běh stáhne jen chybějící soubory.",
    );
  }
  progress(context, `Model Supertonic 3 je připravený v ${cacheDir}.`);
}

/**
 * The pocket-tts Python package, if a snapshot of the Czech model is on disk.
 *
 * Snapshot layout is the standard HF cache: `models--<org>--<repo>/snapshots/<sha>/`.
 * `czech.yaml` is the model config the CLI needs, and `voices/*.wav` are reference
 * recordings; both must be present for the model to be usable.
 */
export async function pocketSnapshot(env = process.env) {
  for (const hub of huggingFaceHubDirs(env)) {
    const snapshots = join(hub, `models--${POCKET_REPO.replace("/", "--")}`, "snapshots");
    let entries;
    try {
      entries = await readdir(snapshots);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const root = join(snapshots, entry);
      const config = join(root, "czech.yaml");
      if (!(await isNonEmptyFile(config))) continue;
      let voices = [];
      try {
        voices = (await readdir(join(root, "voices")))
          .filter((name) => name.endsWith(".wav"))
          .sort()
          .map((name) => ({ id: name.replace(/\.wav$/, ""), path: join(root, "voices", name) }));
      } catch {
        voices = [];
      }
      return { root, config, voices };
    }
  }
  return null;
}

/** Piper voice directories, first one wins per file name. */
export async function piperVoiceDirs(env = process.env) {
  const dirs = [];
  const push = (value) => {
    const path = expandHome(value);
    if (path !== null && !dirs.includes(path)) dirs.push(path);
  };
  push(env?.PHONONSPEAK_PIPER_VOICES);
  push(join(env?.HARNESS_AI ?? HARNESS_AI_ROOT, "models", "piper"));
  push(join(homedir(), ".local", "share", "piper"));
  return dirs;
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

/** Join a list the way a Czech sentence wants it. */
function joinList(values) {
  return values.join(", ");
}

/** Last `count` characters of engine output, with newlines flattened. */
function tail(text, count = 400) {
  const flat = String(text ?? "").trim();
  if (flat.length <= count) return flat;
  return `…${flat.slice(-count)}`;
}

/** One-line, length-capped progress text. */
function shorten(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
