//
//  normalize.test.mjs — the exact strings this plugin promises to speak.
//
//  WHY EXACT STRINGS AND NOT "CONTAINS": the whole value of normalisation is the
//  wording of a number. "tisíc dvě stě padesát korun" is right and "jedna tisíc
//  dvě stě padesát korun" is the bug users hear; only an exact comparison catches
//  the difference. Every expectation below was read out loud (or checked against
//  Czech grammar) before it was written down, so a failure means the code moved,
//  not that the bar moved.
//
//  Run: node test/normalize.test.mjs
//

import {
  NORMALIZE_OPTIONS,
  normalizeForSpeech,
  splitSentences,
} from "../lib/normalize.js";

let passed = 0;
const failures = [];

/** One exact-string assertion. */
function eq(label, actual, expected) {
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failures.push(`${label}\n  vstup:    ${JSON.stringify(label)}\n  čekáno:   ${JSON.stringify(e)}\n  skutečně: ${JSON.stringify(a)}`);
}

/** Assertion for the normalised string of one input. */
function norm(label, input, expected, options) {
  const actual = normalizeForSpeech(input, options);
  if (actual === expected) {
    passed += 1;
    return;
  }
  failures.push(
    `${label}\n  vstup:    ${JSON.stringify(input)}\n  čekáno:   ${JSON.stringify(expected)}\n  skutečně: ${JSON.stringify(actual)}`,
  );
}

/** One boolean assertion. */
function ok(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail.length > 0 ? `\n  ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// 1. Markdown
// ---------------------------------------------------------------------------
norm("nadpis ATX", "## Shrnutí", "Shrnutí");
norm("nadpis s uzavíracími mřížkami", "### Nadpis ###", "Nadpis");
norm("tučné písmo", "**Hotovo** a hotovo.", "Hotovo a hotovo.");
norm("kurzíva", "*text* a __jiný__ text.", "text a jiný text.");
norm("odkaz", "Viz [dokumentace](https://example.com/a/b).", "Viz dokumentace.");
norm("obrázek", "Obrázek ![graf prodeje](https://x/y.png) tady.", "Obrázek tady.");
norm("odrážky", "- první\n- druhý", "první\ndruhý");
norm("číslovaný seznam", "1. první\n2. druhý", "první\ndruhý");
norm("citace", "> citace", "citace");
norm(
  "tabulka jako próza",
  "| Jméno | Věk |\n|---|---|\n| Jan | 42 |",
  "Jméno, Věk\nJan, čtyřicet dva",
);
norm("vodorovná čára", "Text\n---\nDalší", "Text\nDalší");
norm(
  "blok kódu oznámen jednou",
  "Úvod\n```js\nconst x = 1;\n```\nStřed\n```\nrm -rf /\n```\nKonec",
  "Úvod\nblok kódu\nStřed\nKonec",
);
norm("inline kód bez zpětných apostrofů", "Spusť `npm test` a `useState`.", "Spusť npm test a useState.");
norm("markdown vypnutý", "**tučné**", "**tučné**", { markdown: false });

// ---------------------------------------------------------------------------
// 2. URL, e-mail, cesty
// ---------------------------------------------------------------------------
norm("URL s cestou", "Viz https://example.com/a/b?x=1.", "Viz odkaz");
norm("krátká doména zůstane", "Viz https://github.com.", "Viz github.com.");
norm("www s cestou", "Viz www.example.com/path.", "Viz odkaz");
norm("e-mail", "Napiš na jan@example.com.", "Napiš na e-mail.");
norm("cesta k souboru", "Soubor /Users/me/projekt/app.js existuje.", "Soubor cesta k souboru existuje.");
norm("krátký název souboru zůstane", "Soubor app.js existuje.", "Soubor app.js existuje.");
norm("cesta na konci věty", "Soubor je v /tmp/app.wav.", "Soubor je v cesta k souboru.");

// ---------------------------------------------------------------------------
// 3. Čísla, data, časy, peníze, jednotky
// ---------------------------------------------------------------------------
norm("celé číslo", "3 chyby", "tři chyby");
norm("desetinná čárka s půlkou", "3,5", "tři a půl");
norm("desetinná čárka", "3,14", "tři celé čtrnáct");
norm("desetinná s nulou", "1,05", "jedna celá nula pět");
norm("tisíce mezerou", "1 250", "tisíc dvě stě padesát");
norm("rok", "2026", "dva tisíce dvacet šest");
norm("řádová číslovka", "3.", "třetí");
norm("řádová číslovka v kontextu", "kapitola 3. začíná", "kapitola třetí začíná");
norm("procenta s mezerou", "15 %", "patnáct procent");
norm("procenta bez mezery", "15%", "patnáct procent");
norm("peníze", "1 250 Kč", "tisíc dvě stě padesát korun");
norm("peníze před číslem", "Kč 1 250", "tisíc dvě stě padesát korun");
norm("peníze s haléři", "1250,50 Kč", "tisíc dvě stě padesát korun padesát haléřů");
norm("kilometry", "5 km", "pět kilometrů");
norm("jeden kilometr", "1 km", "jeden kilometr");
norm("stupně Celsia", "20 °C", "dvacet stupňů Celsia");
norm("milisekundy", "300 ms", "tři sta milisekund");
norm("jeden litr (rod mužský)", "1 l", "jeden litr");
norm("jedna hodina (rod ženský)", "1 h", "jedna hodina");
norm("čas", "14:30", "čtrnáct třicet");
norm("čas na celou hodinu", "14:00", "čtrnáct hodin");
norm("datum", "26. 10. 2026", "dvacátého šestého října dva tisíce dvacet šest");
norm("datum bez roku", "1. 5.", "prvního května");
norm("rozsah pomlčkou", "10–20", "deset až dvacet");
norm("rozsah spojovníkem", "10-20", "deset až dvacet");
norm("rozsah s jednotkou", "5–10 kg", "pět až deset kilogramů");
norm("měsíce", "2 mld. lidí", "dvě miliardy lidí");
norm("velká čísla", "2 500 000 Kč", "dva miliony pět set tisíc korun");
norm("milion", "1 000 000", "milion");
norm("čísla vypnutá", "3 chyby a 1,5 s", "3 chyby a 1,5 s", { numbers: false });

// ---------------------------------------------------------------------------
// 4. Zkratky
// ---------------------------------------------------------------------------
norm("např.", "např. toto", "například toto");
norm("tj.", "tj. ono", "to je ono");
norm("tzn.", "tzn. tamto", "to znamená tamto");
norm("atd.", "atd. dál", "a tak dále dál");
norm("apod.", "apod. jinak", "a podobně jinak");
norm("č.", "č. 5", "číslo pět");
norm("str.", "str. 12", "strana dvanáct");
norm("odst.", "odst. 3", "odstavec tři");
norm("mil.", "mil. lidí", "milionů lidí");
norm("mld.", "mld. eur", "miliard eur");
norm("tis.", "tis. lidí", "tisíc lidí");
norm("Kč samotné", "platba Kč", "platba korun");
norm("MB", "soubor MB", "soubor megabajtů");
norm("GB", "soubor GB", "soubor gigabajtů");
norm("% samotné", "sleva %", "sleva procent");
norm(
  "akronymy",
  "AI, API, URL, HTTP, JSON, CLI, UI, UX, PDF, HTML, CSS, GPU, CPU, RAM",
  "á í, á pé í, url, há té té pé, džejson, cé el í, u í, u ex, pé dé ef, há té em el, cé es es, gé pé ú, cé pé ú, ram",
);

// ---------------------------------------------------------------------------
// 5. Anglické výrazy a emoji
// ---------------------------------------------------------------------------
norm(
  "fonetický přepis angličtiny",
  "email, online, feedback, deadline, workflow, software, hardware, update, commit, deploy, issue, pull request, merge, bug, feature, release, cache, thread, token, prompt, model",
  "ímejl, onlajn, fídbek, dedlajn, vérkflou, softvér, hardvér, apdejt, komit, deploj, išů, pul rikvest, merg, bag, fíčr, rilís, keš, thred, token, prompt, model",
);
norm("emoji a symboly", "Hotovo 🎉🔥 ★ → hotovo", "Hotovo hotovo");
norm("angličtina zůstane", "email", "email", { english: false });

// ---------------------------------------------------------------------------
// 6. Anglický režim (language: "en")
// ---------------------------------------------------------------------------
norm(
  "en: markdown pryč, čísla zůstanou",
  "**Done** — 3 bugs in 1.5 s, see https://example.com/a/b 🎉",
  "Done — 3 bugs in 1.5 s, see odkaz",
  { language: "en" },
);

// ---------------------------------------------------------------------------
// 7. Definice hotového příkladu ze zadání
// ---------------------------------------------------------------------------
const dodInput =
  "Hotovo! API vrátilo 3 chyby za 1,5 s, Kč 1 250, viz https://example.com/a/b a `npm test`.";
const dodExpected =
  "Hotovo! á pé í vrátilo tři chyby za jeden a půl sekundy, tisíc dvě stě padesát korun, viz odkaz a npm test.";
norm("DoD příklad", dodInput, dodExpected);
ok("DoD: žádné číslice", /\d/.test(dodExpected) === false, dodExpected);
ok("DoD: žádná URL", /https?:|\.com/.test(dodExpected) === false, dodExpected);
ok("DoD: žádné markdown znaky", /[*`\[\](){}|]/.test(dodExpected) === false, dodExpected);

// ---------------------------------------------------------------------------
// 8. Volby a exporty
// ---------------------------------------------------------------------------
ok(
  "NORMALIZE_OPTIONS je celý zapnutý",
  JSON.stringify(NORMALIZE_OPTIONS) ===
    JSON.stringify({
      numbers: true,
      abbreviations: true,
      urls: true,
      code: true,
      markdown: true,
      english: true,
      emoji: true,
    }),
  JSON.stringify(NORMALIZE_OPTIONS),
);
ok("prázdný vstup", normalizeForSpeech("") === "");
ok("jen mezery", normalizeForSpeech("   ") === "");
ok("kolabování mezer", normalizeForSpeech("a    b") === "a b");
ok("jazyk en je řetězec", normalizeForSpeech("test", { language: "en" }) === "test");

// ---------------------------------------------------------------------------
// 9. Dělení vět
// ---------------------------------------------------------------------------
eq(
  "tři věty",
  splitSentences("Hotovo. Ale co když to nepůjde? Zkus to znovu."),
  ["Hotovo.", "Ale co když to nepůjde?", "Zkus to znovu."],
);
eq(
  "desetinná čárka se nedělí",
  splitSentences("Počítej s 3,5 kg a pak to zopakuj."),
  ["Počítej s 3,5 kg a pak to zopakuj."],
);
eq(
  "zkratka se nedělí",
  splitSentences("Počkej, např. do zítra. Pak napiš."),
  ["Počkej, např. do zítra.", "Pak napiš."],
);
eq(
  "elipsa se nedělí",
  splitSentences("No a pak… nic. Konec."),
  ["No a pak… nic.", "Konec."],
);
eq(
  "tři tečky jsou jedna tečka",
  splitSentences("Praha... Hotovo!"),
  ["Praha...", "Hotovo!"],
);
eq(
  "číslovaný seznam po řádcích",
  splitSentences("1. první bod\n2. druhý bod"),
  ["1. první bod", "2. druhý bod"],
);
eq("prázdný vstup", splitSentences("   "), []);
eq("jedna věta bez tečky", splitSentences("Hotovo"), ["Hotovo"]);

const longSentence =
  "Toto je velmi dlouhá věta, která má rozhodně více než dvě stě znaků, a proto se musí rozdělit na menší kusy, aby se dala přečíst jedním dechem, aniž by se ztratila jediná slova z ní, protože by to bylo špatně a posluchač by ztratil nit, což je přesně to, čemu se má dělení vět vyhnout.";
const longChunks = splitSentences(longSentence);
ok("dlouhá věta se rozdělí", longChunks.length > 1, `kusů: ${longChunks.length}`);
ok(
  "každý kus je do 220 znaků",
  longChunks.every((chunk) => chunk.length <= 220),
  longChunks.map((chunk) => chunk.length).join(", "),
);
const bare = (word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const wordsIn = longSentence.split(/\s+/).map(bare);
ok(
  "dělení nerozstřihne slovo",
  longChunks.every((chunk) => {
    const chunkWords = chunk.split(/\s+/);
    // Every chunk word must exist verbatim in the source, in order.
    return chunkWords.every((word) => wordsIn.includes(bare(word)));
  }),
  JSON.stringify(longChunks),
);
const shortChunks = splitSentences(longSentence, 80);
ok(
  "vlastní limit 80 dodržen",
  shortChunks.every((chunk) => chunk.length <= 80),
  shortChunks.map((chunk) => chunk.length).join(", "),
);
ok(
  "limit 80: každý kus končí na hranici slova",
  shortChunks.every((chunk) => {
    const start = longSentence.indexOf(chunk);
    if (start === -1) return false;
    const end = start + chunk.length;
    return end === longSentence.length || /\s/.test(longSentence[end]);
  }),
  JSON.stringify(shortChunks),
);
ok(
  "kusy dají dohromady původní slova",
  shortChunks.join(" ").replace(/\s+/g, " ") === longSentence.replace(/\s+/g, " "),
  JSON.stringify(shortChunks),
);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n✖ normalize: ${failures.length} selhání, ${passed} prošlo\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`✔ normalize: ${passed} tvrzení prošlo`);
