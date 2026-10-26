//
//  client-strings.test.mjs — guards the Web half's easy-to-break invariants.
//
//  WHY THIS TEST EXISTS: the browser module is not importable (it calls
//  window.__ModuleLoader__.load and expects React), so a TypeScript or bundler
//  check cannot see it. The two things that silently break the UI are (1) a
//  syntax error that only appears after the page loads, and (2) a locale key
//  that exists in one language but not the other. Both are cheap to check here.
//
//  The route literals are part of the same contract: lib/contract.js documents
//  them and the Host registers them, but the client repeats them by necessity.
//
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const clientPath = join(root, "lib", "client.js");
const source = readFileSync(clientPath, "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// 1. The module is syntactically valid. `--check` never executes it, and
//    `--input-type=module` makes Node parse it as a module even though it has
//    no import statements (the loader wrapper provides `require`).
const syntax = spawnSync(
  process.execPath,
  ["--input-type=module", "--check"],
  { input: source, encoding: "utf8" },
);
assert.equal(
  syntax.status,
  0,
  `lib/client.js does not parse:\n${syntax.stderr || syntax.stdout}`,
);

// 2. The module loader id must equal the package name, or the Host serves the
//    bundle under a name the loader never activates.
const loaderMatch = /window\.__ModuleLoader__\.load\(\s*\{\s*id\s*:\s*["']([^"']+)["']/.exec(
  source,
);
assert.ok(loaderMatch, "lib/client.js has no window.__ModuleLoader__.load({ id }) block");
assert.equal(
  loaderMatch[1],
  pkg.name,
  `module loader id ${loaderMatch[1]} does not match package name ${pkg.name}`,
);

// 3. Both dictionaries carry the same flattened key set. Nested `meta` is
//    flattened too, so `meta.title` counts like any other key.
const en = JSON.parse(readFileSync(join(root, "locale", "en.json"), "utf8"));
const cs = JSON.parse(readFileSync(join(root, "locale", "cs.json"), "utf8"));

function flatten(object, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(object)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flatten(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

const enKeys = flatten(en).sort();
const csKeys = flatten(cs).sort();
const missingInCs = enKeys.filter((key) => !csKeys.includes(key));
const missingInEn = csKeys.filter((key) => !enKeys.includes(key));
assert.deepEqual(missingInCs, [], `locale/cs.json is missing: ${missingInCs.join(", ")}`);
assert.deepEqual(missingInEn, [], `locale/en.json is missing: ${missingInEn.join(", ")}`);
assert.deepEqual(csKeys, enKeys, "locale dictionaries differ in key set");

// 4. The English package file must carry the market metadata. The Czech file
//    mirrors it so the key-set assertion above stays meaningful.
assert.equal(typeof en.meta?.title, "string", "locale/en.json needs meta.title");
assert.ok(en.meta.title.length > 0, "locale/en.json meta.title must not be empty");
assert.equal(typeof en.meta?.description, "string", "locale/en.json needs meta.description");
assert.ok(en.meta.description.length > 0, "locale/en.json meta.description must not be empty");
assert.equal(typeof cs.meta?.title, "string", "locale/cs.json needs meta.title");
assert.equal(typeof cs.meta?.description, "string", "locale/cs.json needs meta.description");

// 5. The route table is repeated literally by necessity; the Host enforces the
//    same paths. If one changes, this test is the first thing that notices.
const routes = [
  "/dsh-phononspeak/state",
  "/dsh-phononspeak/config",
  "/dsh-phononspeak/action",
  "/dsh-phononspeak/presence",
  "/dsh-phononspeak/setup",
  "/dsh-phononspeak/audio/",
];
for (const route of routes) {
  assert.ok(
    source.includes(`"${route}"`) || source.includes(`'${route}'`),
    `lib/client.js is missing the route literal ${route}`,
  );
}

// 6. Exactly the three approved slots, under the approved identifiers. The
//    browser half must not grow a fourth registration into an unowned surface.
const slotNames = [...source.matchAll(/\bname:\s*["']([^"']+)["']/g)].map((match) => match[1]);
assert.deepEqual(
  new Set(slotNames),
  new Set(["settings.section", "shell.overlay", "tool.call.toolview"]),
  `unexpected slot registrations: ${slotNames.join(", ")}`,
);
assert.ok(source.includes('id: "phononspeak"'), "settings.section id must be phononspeak");
assert.ok(source.includes('id: "phononspeak-player"'), "shell.overlay id must be phononspeak-player");
assert.ok(source.includes('key: "dsh_phononspeak"'), "tool.call.toolview key must be dsh_phononspeak");

// 7. The dictionaries embedded in the browser module are the same keys as the
//    package files. The module cannot read JSON at runtime, so this duplication
//    is intentional — and therefore worth locking.
const dictsStart = source.indexOf("const DICTS = ");
assert.ok(dictsStart >= 0, "lib/client.js has no DICTS object");
const objectStart = source.indexOf("{", dictsStart);
let depth = 0;
let inString = false;
let quote = "";
let escaped = false;
let objectEnd = -1;
for (let index = objectStart; index < source.length; index += 1) {
  const character = source[index];
  if (inString) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      inString = false;
    }
    continue;
  }
  if (character === `"` || character === `'`) {
    inString = true;
    quote = character;
    continue;
  }
  if (character === "{") {
    depth += 1;
    continue;
  }
  if (character === "}") {
    depth -= 1;
    if (depth === 0) {
      objectEnd = index;
      break;
    }
  }
}
assert.ok(objectEnd > objectStart, "could not find the end of DICTS in lib/client.js");
const literals = new Function(`return (${source.slice(objectStart, objectEnd + 1)});`)();
assert.deepEqual(
  flatten(literals.cs).sort(),
  csKeys,
  "client DICTS.cs keys drifted from locale/cs.json",
);
assert.deepEqual(
  flatten(literals.en).sort(),
  enKeys,
  "client DICTS.en keys drifted from locale/en.json",
);

console.log(
  `client-strings: ok (${slotNames.length} slots, ${enKeys.length} locale keys, ${routes.length} routes)`,
);
