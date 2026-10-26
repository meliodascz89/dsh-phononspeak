//
//  engines.test.mjs — the engine layer, measured rather than assumed.
//
//  WHY THIS TEST PROVISIONS FOR REAL: a "detect returns four records" test passes
//  on a machine where nothing can speak, and that is the state this plugin must
//  never ship in. So the test provisions Supertonic through `ensureEngine`, runs a
//  real synthesis, parses the WAV it produced and prints the measured latency and
//  real-time factor. When the engine genuinely cannot be provisioned (no network,
//  no Python wheel), the test skips with the reason instead of turning green by
//  accident — the skip is printed, and it says what is missing.
//
//  WHY IT CHECKS AVAILABILITY BEFORE AND AFTER: the contract with the Host is
//  "available only after ensureEngine". A detection that says "available" on a
//  fresh dataDir would make the settings page offer an engine that cannot speak,
//  and the user would hear silence instead of an error.
//
//  Run: node test/engines.test.mjs [--no-provision]
//

import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ENGINE_CATALOG,
  detectEngines,
  ensureEngine,
  isEngineId,
  listVoices,
  synthesize,
  inspectAudio,
} from "../lib/engines.js";
import { ENGINE_IDS } from "../lib/contract.js";
import { normalizeForSpeech } from "../lib/normalize.js";
import { enginePaths } from "../lib/provision.js";

const DATA_DIR = process.env.PHONONSPEAK_TEST_DIR ?? "/tmp/phononspeak-test";
const PROVISION = process.argv.includes("--no-provision") ? false : true;

let passed = 0;
let skipped = 0;
const failures = [];

function ok(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail.length > 0 ? `\n  ${detail}` : ""}`);
}

function skip(label, reason) {
  skipped += 1;
  console.log(`  ∼ SKIP ${label}: ${reason}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Seconds of PCM audio inside a WAV, from the facts the parser returned. */
function durationOf(info) {
  const bytesPerFrame = (info.bitsPerSample / 8) * info.channels;
  if (!Number.isFinite(info.sampleRate) || info.sampleRate <= 0 || bytesPerFrame <= 0) return 0;
  if (!Number.isFinite(info.dataBytes) || info.dataBytes <= 0) return 0;
  return info.dataBytes / (info.sampleRate * bytesPerFrame);
}

// ---------------------------------------------------------------------------
// 1. detection: shape, no throw, honest availability
// ---------------------------------------------------------------------------
section("1. detekce enginů");

let statuses = [];
try {
  statuses = await detectEngines({ dataDir: DATA_DIR });
  ok("detectEngines nevyhodí", true);
} catch (error) {
  ok("detectEngines nevyhodí", false, `vyhodilo: ${error.message}`);
}

ok("detectEngines vrátí 4 záznamy", statuses.length === 4, `dostal jsem ${statuses.length}`);
ok(
  "ids odpovídají kontraktu",
  statuses.map((status) => status.id).join(",") === ENGINE_IDS.join(","),
  statuses.map((status) => status.id).join(","),
);

const REQUIRED_KEYS = [
  "id", "label", "license", "licenseUrl", "commercial", "personalOnly", "cloning",
  "languages", "sizeHint", "notes", "available", "installed", "reason", "runtime", "voices",
];
for (const status of statuses) {
  const missing = REQUIRED_KEYS.filter((key) => !(key in status));
  ok(`${status.id}: má všechna pole`, missing.length === 0, `chybí: ${missing.join(", ")}`);
  ok(`${status.id}: available je boolean`, typeof status.available === "boolean");
  ok(`${status.id}: installed je boolean`, typeof status.installed === "boolean");
  ok(`${status.id}: reason je string|null`, status.reason === null || typeof status.reason === "string");
  ok(`${status.id}: voices je pole`, Array.isArray(status.voices));
  ok(`${status.id}: languages obsahuje cs`, Array.isArray(status.languages) && status.languages.includes("cs"));
  for (const voice of status.voices) {
    ok(
      `${status.id}: hlas ${voice.id} má engin a jazyk`,
      voice.engine === status.id && (voice.language === "cs" || voice.language === "en"),
      JSON.stringify(voice),
    );
  }
}

const byId = Object.fromEntries(statuses.map((status) => [status.id, status]));

// The licence facts the Host's commercial gate depends on.
ok("say je jen osobní", byId.say.personalOnly === true && byId.say.commercial === false);
ok("pocket klonuje", byId.pocket.cloning === true);
ok("supertonic neklonuje", byId.supertonic.cloning === false);
ok("piper neklonuje", byId.piper.cloning === false);
ok("katalog má 4 záznamy", ENGINE_CATALOG.length === 4);
ok("isEngineId souhlasí s kontraktem", ENGINE_IDS.every((id) => isEngineId(id)) && !isEngineId("nope"));
ok("isEngineId odmítne neřetězec", !isEngineId(null) && !isEngineId(42));

section("   naměřený stav");
for (const status of statuses) {
  const voices = status.voices.length === 0 ? "—" : `${status.voices.length} hlasů`;
  console.log(
    `   ${status.id.padEnd(11)} available=${String(status.available).padEnd(5)} ` +
      `installed=${String(status.installed).padEnd(5)} hlasy=${voices.padEnd(10)} ` +
      `runtime=${status.runtime ?? "—"}`,
  );
  if (status.reason !== null) console.log(`              důvod: ${status.reason}`);
}

// supertonic must not claim readiness on a fresh directory.
if (!byId.supertonic.available) {
  ok(
    "supertonic nepředstírá dostupnost",
    typeof byId.supertonic.reason === "string" && byId.supertonic.reason.length > 0,
    "není dostupný, ale nemá důvod",
  );
}

// piper: the honest statement on this machine is "no binary".
if (byId.piper.available) {
  ok("piper: runtime existuje", typeof byId.piper.runtime === "string" && isAbsolute(byId.piper.runtime));
  console.log("  ∼ piper je na tomto stroji k dispozici — test neověřuje jeho binárku podrobněji.");
} else {
  ok(
    "piper: důvod mluví o binárce",
    /piper|PATH/i.test(byId.piper.reason ?? ""),
    byId.piper.reason ?? "chybí důvod",
  );
}

// pocket: needs provisioning or an explicitly trusted interpreter.
if (!byId.pocket.available) {
  ok(
    "pocket: důvod je konkrétní",
    typeof byId.pocket.reason === "string" && byId.pocket.reason.length > 0,
    "není dostupný, ale nemá důvod",
  );
}

// say: always there on macOS.
if (process.platform === "darwin") {
  ok("say je na macOS dostupný", byId.say.available === true && isAbsolute(byId.say.runtime ?? ""));
  ok("say zná Zuzanu", byId.say.voices.some((voice) => voice.id === "Zuzana"));
} else {
  skip("say", "nejde o macOS");
}

// ---------------------------------------------------------------------------
// 2. provisioning
// ---------------------------------------------------------------------------
section("2. zprovoznění supertonicu");

let supertonicReady = byId.supertonic.available;
if (!PROVISION) {
  skip("ensureEngine(supertonic)", "spuštěno s --no-provision");
} else if (supertonicReady) {
  console.log("  · supertonic už je zprovozněný, přeskakuji instalaci");
} else {
  console.log("  · zprovozňuji supertonic (pip install do vlastního venv)…");
  try {
    const startedAt = Date.now();
    const provisioned = await ensureEngine("supertonic", {
      dataDir: DATA_DIR,
      onProgress: (message) => console.log(`      · ${message}`),
    });
    supertonicReady = provisioned.available;
    ok("ensureEngine(supertonic) vrátí available", provisioned.available === true, provisioned.reason ?? "");
    console.log(`  · zprovoznění trvalo ${Date.now() - startedAt} ms`);
  } catch (error) {
    supertonicReady = false;
    skip("ensureEngine(supertonic)", `zprovoznění selhalo: ${error.message}`);
  }
}

if (supertonicReady) {
  const after = (await detectEngines({ dataDir: DATA_DIR })).find((status) => status.id === "supertonic");
  ok("detect po zprovoznění hlásí available", after?.available === true, after?.reason ?? "");
  ok("runtime supertonicu existuje", typeof after?.runtime === "string" && isAbsolute(after.runtime));
  const info = await stat(after.runtime).catch(() => null);
  ok("runtime je spustitelný soubor", info !== null && info.isFile(), after?.runtime ?? "—");
  ok("supertonic má 10 hlasových stylů", after?.voices.length === 10, `má ${after?.voices.length}`);
  ok(
    "supertonic zná M1 i F1",
    after?.voices.some((voice) => voice.id === "M1") && after?.voices.some((voice) => voice.id === "F1"),
  );

  const secondStarted = Date.now();
  const again = await ensureEngine("supertonic", { dataDir: DATA_DIR });
  const secondMs = Date.now() - secondStarted;
  ok("druhé zprovoznění je rychlé (markery)", again.available === true && secondMs < 10_000, `${secondMs} ms`);
  console.log(`  · opakované zprovoznění: ${secondMs} ms`);
}

// ---------------------------------------------------------------------------
// 3. voices
// ---------------------------------------------------------------------------
section("3. hlasy");
if (supertonicReady) {
  const voices = await listVoices("supertonic", { dataDir: DATA_DIR });
  ok("listVoices vrací 10 stylů", voices.length === 10, `${voices.length}`);
  ok("hlasy nesou engine", voices.every((voice) => voice.engine === "supertonic"));
  ok("hlasy mají český jazyk", voices.every((voice) => voice.language === "cs"));
}
ok("listVoices pro neznámý engine vrátí prázdno", (await listVoices("auto", { dataDir: DATA_DIR })).length === 0);
ok("piper hlasy odpovídají názvům souborů", byId.piper.voices.every((voice) => voice.id.includes("_")));

// ---------------------------------------------------------------------------
// 4. syntéza: skutečný WAV, skutečná čísla
// ---------------------------------------------------------------------------
section("4. syntéza");

const spoken = normalizeForSpeech(
  "Hotovo! API vrátilo 3 chyby za 1,5 s, Kč 1 250, viz https://example.com/a/b a `npm test`.",
);
console.log(`  · text: ${spoken}`);

if (!supertonicReady) {
  skip("syntéza supertonic", "engine není zprovozněný — spusť bez --no-provision");
} else {
  const outFile = join(DATA_DIR, `measure-${Date.now()}.wav`);
  const startedAt = Date.now();
  let result = null;
  try {
    result = await synthesize({
      engineId: "supertonic",
      text: spoken,
      voice: "M1",
      language: "cs",
      speed: 1.0,
      dataDir: DATA_DIR,
      outFile,
      onProgress: () => {},
    });
    ok("syntéza doběhla", true);
  } catch (error) {
    ok("syntéza doběhla", false, error.message);
  }

  if (result !== null) {
    const wallMs = Date.now() - startedAt;
    const fileInfo = await stat(result.file).catch(() => null);
    const info = await inspectAudio(result.file);
    const seconds = durationOf(info ?? {});

    ok("soubor existuje", fileInfo !== null && fileInfo.isFile(), result.file);
    ok("soubor není prázdný", (fileInfo?.size ?? 0) > 1000, `${fileInfo?.size ?? 0} B`);
    ok("engine v odpovědi", result.engine === "supertonic");
    ok("hlas v odpovědi", result.voice === "M1");
    ok("ms je kladné číslo", Number.isFinite(result.ms) && result.ms > 0, `${result.ms}`);
    ok("bytes odpovídá souboru", result.bytes === (fileInfo?.size ?? -1), `${result.bytes} vs ${fileInfo?.size}`);
    ok("vzorkovací frekvence je plausibilní", result.sampleRate === 44100, `${result.sampleRate} Hz`);
    ok("hlavička WAV", info?.container === "wav", JSON.stringify(info));
    ok("kanál mono", info?.channels === 1, JSON.stringify(info));
    ok("16 bitů", info?.bitsPerSample === 16, JSON.stringify(info));
    ok("délka mezi 1 a 60 s", seconds > 1 && seconds < 60, `${seconds.toFixed(2)} s`);
    ok("soubor leží v dataDir", result.file.startsWith(DATA_DIR), result.file);

    const rtf = seconds > 0 ? result.ms / 1000 / seconds : 0;
    console.log("\n   naměřeno (Supertonic 3, M1, cs):");
    console.log(`     stěna (včetně startu procesu): ${wallMs} ms`);
    console.log(`     ms z synthesize():             ${result.ms} ms`);
    console.log(`     délka audia:                   ${seconds.toFixed(2)} s`);
    console.log(`     vzorkovací frekvence:          ${result.sampleRate} Hz`);
    console.log(`     velikost:                      ${result.bytes} B`);
    console.log(`     RTF (ms / audio):              ${rtf.toFixed(2)}`);
  }
}

// say: cheap second engine, and the only one that writes a JUNK chunk before fmt,
// which is exactly what the WAV parser must survive.
if (process.platform === "darwin" && byId.say.available) {
  try {
    const outFile = join(DATA_DIR, `say-${Date.now()}.wav`);
    const result = await synthesize({ engineId: "say", text: "Test systémového hlasu.", dataDir: DATA_DIR, outFile });
    const info = await inspectAudio(result.file);
    ok("say: WAV i s JUNK chunkeM", info?.container === "wav" && info?.sampleRate > 0, JSON.stringify(info));
    ok("say: vzorkovací frekvence 22050", result.sampleRate === 22050, `${result.sampleRate}`);
    console.log(`  · say: ${result.ms} ms, ${durationOf(info ?? {}).toFixed(2)} s, ${result.sampleRate} Hz`);
  } catch (error) {
    ok("say: syntéza", false, error.message);
  }
} else {
  skip("say syntéza", "say není k dispozici");
}

// ---------------------------------------------------------------------------
// 5. stop (AbortSignal) a chybové stavy
// ---------------------------------------------------------------------------
section("5. stop a chyby");

if (supertonicReady) {
  const controller = new AbortController();
  const outFile = join(DATA_DIR, `aborted-${Date.now()}.wav`);
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), 150);
  let abortedError = null;
  try {
    await synthesize({
      engineId: "supertonic",
      text: "Toto je delší text, který se má přerušit, aby se ověřilo, že stop opravdu zabije proces a nezůstane po něm soubor.",
      dataDir: DATA_DIR,
      outFile,
      signal: controller.signal,
    });
  } catch (error) {
    abortedError = error;
  } finally {
    clearTimeout(timer);
  }
  const stopMs = Date.now() - startedAt;
  ok("stop vyhodí chybu", abortedError !== null, "syntéza po abortu neselhalа");
  ok("stop je pojmenovaný jako přerušení", /přerušen/i.test(abortedError?.message ?? ""), abortedError?.message ?? "");
  const leftover = await stat(outFile).catch(() => null);
  ok("po stopu nezůstane půlka souboru", leftover === null, `zůstal ${outFile}`);
  console.log(`  · stop zabral ${stopMs} ms a nenechal soubor`);
} else {
  skip("stop", "supertonic není zprovozněný");
}

let unknownError = null;
try {
  await synthesize({ engineId: "nope", text: "x", dataDir: DATA_DIR });
} catch (error) {
  unknownError = error;
}
ok("neznámý engine vyhodí chybu", unknownError !== null);
ok("chyba neznámého enginu je česky", /Neznámý engine/.test(unknownError?.message ?? ""), unknownError?.message ?? "");

if (!byId.piper.available) {
  let piperError = null;
  try {
    await synthesize({ engineId: "piper", text: "x", dataDir: DATA_DIR });
  } catch (error) {
    piperError = error;
  }
  ok("nedostupný piper vyhodí chybu", piperError !== null);
  ok(
    "chyba piperu nese důvod",
    /piper|PATH/i.test(piperError?.message ?? ""),
    piperError?.message ?? "",
  );
} else {
  skip("nedostupný piper", "piper je na tomto stroji dostupný");
}

let piperProvisionError = null;
try {
  await ensureEngine("piper", { dataDir: DATA_DIR });
} catch (error) {
  piperProvisionError = error;
}
if (byId.piper.available) {
  skip("ensureEngine(piper) odmítne", "piper je dostupný");
} else {
  ok("ensureEngine(piper) odmítne s vysvětlením", piperProvisionError !== null && /piper/i.test(piperProvisionError.message));
}

// ---------------------------------------------------------------------------
// 6. cesty
// ---------------------------------------------------------------------------
section("6. cesty");
const paths = enginePaths(DATA_DIR);
ok("enginePaths je absolutní", isAbsolute(paths.root) && isAbsolute(paths.cache));
ok(
  "enginePaths má všech sedm položek",
  ["root", "bin", "venvSupertonic", "venvPocket", "cache", "voicesDir", "audioDir", "settingsFile"].every(
    (key) => typeof paths[key] === "string" && paths[key].length > 0,
  ),
  JSON.stringify(paths),
);
ok("venv supertonicu je v dataDir", paths.venvSupertonic.startsWith(paths.root));
ok("venv pocketu je v dataDir", paths.venvPocket.startsWith(paths.root));

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log("");
if (failures.length > 0) {
  console.error(`✖ engines: ${failures.length} selhání, ${passed} prošlo, ${skipped} přeskočeno\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`✔ engines: ${passed} tvrzení prošlo, ${skipped} přeskočeno`);
