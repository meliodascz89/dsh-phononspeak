#!/usr/bin/env node
//
//  verify.mjs — the checks that must pass before a release is published.
//
//  WHY: the marketplace installs a bundle by parsing its patch and composing
//  its rows; a typo in `cordis.patch.yml`, a client id that differs from the
//  package name, or a stale route literal fails at runtime for the user, not
//  for us. Everything checkable without a running Harness is checked here, in
//  one command, so "it installs" is not a claim made from memory.
//
//  Usage: node scripts/verify.mjs
//

import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const failures = [];
const passes = [];

function ok(message) {
  passes.push(message);
}
function fail(message) {
  failures.push(message);
}

async function exists(rel) {
  try {
    await stat(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/* ------------------------------------------------------------------ manifest */

if (pkg.name === "dsh-phononspeak" || /^[a-z0-9][a-z0-9._~-]*$/.test(pkg.name)) ok(`package name ${pkg.name}`);
else fail(`package name is not installable: ${pkg.name}`);

if (pkg.type === "module") ok("ESM package");
else fail("package.json type must be module");

for (const key of [".", "./client", "./locale/*.json", "./icon", "./package.json"]) {
  if (pkg.exports?.[key]) ok(`exports ${key}`);
  else fail(`missing exports ${key}`);
}

if (pkg.dsh?.bundle?.patch) ok("dsh.bundle.patch declared");
else fail("dsh.bundle.patch missing");

if (pkg.dsh?.client?.platform === "web") ok("web client declared");
else fail("dsh.client.platform must be web");

if (pkg.scripts?.prepare || pkg.scripts?.install) fail("prepare/install scripts make pnpm ask for build approval");
else ok("no prepare/install scripts");

const peerNames = Object.keys(pkg.peerDependencies ?? {});
for (const peer of peerNames) {
  const range = pkg.peerDependencies[peer];
  if (/^\^0\.\d/.test(range)) fail(`peer ${peer} uses a caret range that the loader will skip: ${range}`);
}
if (peerNames.length) ok(`peer ranges: ${peerNames.map((n) => `${n} ${pkg.peerDependencies[n]}`).join(", ")}`);

/* --------------------------------------------------------------------- patch */

const patch = await readFile(join(root, "cordis.patch.yml"), "utf8").catch(() => "");
if (!patch) fail("cordis.patch.yml missing");
else {
  if (/insert:/.test(patch) && patch.includes(`'${pkg.name}'`)) ok("patch inserts the package row");
  else fail("cordis.patch.yml must insert a row named after the package");
}

/* ------------------------------------------------------------------ syntax */

const libFiles = (await readdir(join(root, "lib")).catch(() => [])).filter((file) => file.endsWith(".js"));
if (libFiles.length === 0) fail("lib/ is empty");
for (const file of libFiles) {
  const check = spawnSync(process.execPath, ["--check", join(root, "lib", file)], { encoding: "utf8" });
  if (check.status === 0) ok(`node --check lib/${file}`);
  else fail(`syntax error in lib/${file}: ${check.stderr.trim().split("\n").pop()}`);
}

/* ------------------------------------------------------------------- client */

const clientPath = join(root, "lib", "client.js");
if (!(await exists("lib/client.js"))) fail("lib/client.js missing");
else {
  const client = await readFile(clientPath, "utf8");
  if (client.includes(`id: '${pkg.name}'`) || client.includes(`id: "${pkg.name}"`)) ok("client module id matches package name");
  else fail("client module id must equal the package name");

  const contract = await readFile(join(root, "lib", "contract.js"), "utf8");
  for (const route of ["/dsh-phononspeak/state", "/dsh-phononspeak/config", "/dsh-phononspeak/action", "/dsh-phononspeak/presence", "/dsh-phononspeak/setup", "/dsh-phononspeak/audio/"]) {
    if (!contract.includes(route)) fail(`contract.js is missing ${route}`);
    if (!client.includes(route)) fail(`client.js does not call ${route}`);
  }
  ok("client and contract agree on every route");

  for (const forbidden of ["settingsScope", "SettingsForms", "localStorage", "document.body.appendChild"]) {
    if (client.includes(forbidden)) fail(`client.js uses ${forbidden}, which does not exist in this runtime`);
  }
}

/* ---------------------------------------------------------------- locale/img */

for (const locale of ["en", "cs"]) {
  const file = join(root, "locale", `${locale}.json`);
  try {
    const dict = JSON.parse(await readFile(file, "utf8"));
    if (!dict.meta?.title) fail(`locale/${locale}.json has no meta.title`);
    else if (!dict.meta?.description) fail(`locale/${locale}.json has no meta.description`);
    else ok(`locale/${locale}.json meta present`);
  } catch {
    fail(`locale/${locale}.json missing or invalid`);
  }
}

if (await exists("icon.svg")) {
  const icon = await readFile(join(root, "icon.svg"), "utf8");
  if (icon.length > 256 * 1024) fail("icon.svg is larger than 256 KiB");
  else if (!icon.includes("<svg")) fail("icon.svg is not an SVG");
  else ok(`icon.svg (${icon.length} bytes)`);
} else fail("icon.svg missing");

/* -------------------------------------------------------------------- tests */

const tests = (await readdir(join(root, "test")).catch(() => [])).filter((file) => file.endsWith(".test.mjs"));
if (tests.length === 0) fail("no tests found");
for (const test of tests) {
  const run = spawnSync(process.execPath, [join(root, "test", test)], { encoding: "utf8", timeout: 300000 });
  if (run.status === 0) ok(`test/${test}`);
  else {
    const tail = (run.stderr || run.stdout || "").trim().split("\n").slice(-6).join(" | ");
    fail(`test/${test} failed: ${tail}`);
  }
}

/* ---------------------------------------------------------------------- docs */

for (const doc of ["README.md", "README.cs.md", "CHANGELOG.md", "LICENSE", "docs/ARCHITECTURE.md", "docs/VOICES.md", "docs/PRIVACY.md", "docs/TROUBLESHOOTING.md"]) {
  if (await exists(doc)) ok(doc);
  else fail(`${doc} missing`);
}

for (const readme of ["README.md", "README.cs.md"]) {
  if (!(await exists(readme))) continue;
  const text = await readFile(join(root, readme), "utf8");
  const links = [...text.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)].map((match) => match[1].split("#")[0]);
  for (const link of links) {
    if (!(await exists(link))) fail(`${readme} links to a missing file: ${link}`);
  }
}

/* -------------------------------------------------------------------- report */

console.log(`\nphononspeak verify — ${passes.length} passed, ${failures.length} failed\n`);
for (const line of passes) console.log(`  ✓ ${line}`);
for (const line of failures) console.log(`  ✗ ${line}`);
if (failures.length) {
  console.log("\nrelease is blocked");
  process.exit(1);
}
console.log("\nall checks passed — the bundle is installable");
