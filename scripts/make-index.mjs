#!/usr/bin/env node
//
//  make-index.mjs — write the plugin-market index entry for this repository.
//
//  WHY A SCRIPT AND NOT A HAND-WRITTEN FILE: the market index validates every
//  version, and a `git` source must name a full 40-hex commit. Forgetting to
//  bump one of the three values (version, commit, publishTimestamp) makes the
//  entry silently look stale or "update available", which is exactly the kind
//  of failure nobody notices until a user reports it. Generating the file from
//  git and package.json removes the chance to mistype the commit.
//
//  Usage: node scripts/make-index.mjs [--out index.json]
//

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const out = outFlag >= 0 && args[outFlag + 1] ? resolve(args[outFlag + 1]) : join(root, "index.json");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const repo = "https://github.com/meliodascz89/dsh-phononspeak";

let commit;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  console.error("make-index: not a git repository — commit the release first.");
  process.exit(1);
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error("make-index: git returned a non-canonical commit:", commit);
  process.exit(1);
}

/** Keep earlier versions so users can pin a known-good release. */
async function previousVersions() {
  try {
    const raw = JSON.parse(await readFile(out, "utf8"));
    const plugin = raw?.plugins?.find((entry) => entry.name === pkg.name);
    const versions = Array.isArray(plugin?.versions) ? plugin.versions : [];
    return versions.filter((entry) => entry.version !== pkg.version && entry.source?.commit !== commit);
  } catch {
    return [];
  }
}

const entry = {
  version: pkg.version,
  publishTimestamp: Math.floor(Date.now() / 1000),
  source: { type: "git", url: repo, commit },
  engines: { dsh: ">=0.2.1-rc.3 <0.3.0-0" },
};

const index = {
  format: 1,
  title: { en: "Phononspeak", cs: "Phononspeak" },
  description: {
    en: "Local, Czech-first voice channel for DeepSeek Harness agents: summary read-aloud, attention calls, own settings UI.",
    cs: "Lokální český hlasový kanál pro agenty DeepSeek Harness: čtení shrnutí, volání k počítači, vlastní nastavení.",
  },
  metadata: {
    categories: { voice: { title: { en: "Voice & Audio", cs: "Hlas a audio" } } },
    labels: { git: { title: { en: "Git install", cs: "Instalace z Gitu" } } },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: "Phononspeak", cs: "Phononspeak" },
      description: {
        en: "Reads answer summaries aloud and calls you to the computer when the agent needs a decision. Queue, stop, own UI. Local engines only.",
        cs: "Přečte shrnutí odpovědi a zavolá tě k počítači, když agent potřebuje rozhodnutí. Fronta, stop, vlastní UI. Jen lokální enginy.",
      },
      author: "Michal Ožuch",
      homepage: repo,
      repository: { url: repo },
      icon: "./icon.svg",
      metadata: { category: "voice", labels: ["git"], keywords: ["tts", "voice", "czech", "summary", "accessibility"] },
      versions: [entry, ...(await previousVersions())],
    },
  ],
};

await writeFile(out, `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`make-index: wrote ${out}`);
console.log(`  ${pkg.name}@${pkg.version}  commit ${commit.slice(0, 10)}…`);
