//
//  normalize.js — text that a Czech TTS engine can actually read aloud.
//
//  WHY THIS FILE EXISTS AT ALL: none of the engines we can legally ship is a
//  reader. Supertonic does not expand "Kč" (measured: it says "kač"), Piper reads
//  "Vltava" as "Voltava", and every one of them stumbles over Markdown, URLs and
//  code fences. The user's trust is won or lost right here: one mispronounced
//  amount and the voice sounds like a machine reading a log file — which is
//  exactly what it would be.
//
//  WHY NUMBERS ARE THE HARD PART: Czech numerals inflect with the counted noun
//  ("pět kilometrů" but "dva kilometry"), the date is genitive ("dvacátého šestého
//  října"), and a thousand is "tisíc" when alone but "dva tisíce" after a two.
//  A single "read the digits" pass produces Czech that is understandable and
//  wrong, so the number machinery below carries the case forms instead of
//  pretending one string fits every context.
//
//  WHY ORDER IS LOAD-BEARING: dates must be consumed before the generic ordinal
//  rule eats "26."; money before units, or "1 250 Kč" becomes "tisíc dvě stě
//  padesát korun" via a lucky accident; URLs before file paths, or the path rule
//  chews the URL into "cesta k souboru"; Markdown before everything, or the
//  asterisks land inside the numbers. Each step in `normalizeForSpeech` is
//  therefore in a deliberate order, and the comments say which mistake the order
//  prevents.
//
//  WHAT IS DELIBERATELY NOT DONE: we never invent content ("blok kódu" is the one
//  insertion, and only when a fence was actually removed), never translate, and
//  never drop a sentence. A skipped thing is announced, because silently skipping
//  is the failure mode where the listener believes they heard everything.
//

/** Every transformation this module knows, all on by default. */
export const NORMALIZE_OPTIONS = Object.freeze({
  numbers: true,
  abbreviations: true,
  urls: true,
  code: true,
  markdown: true,
  english: true,
  emoji: true,
});

/** Default chunk size for `splitSentences`; mirrors contract LIMITS.segmentMaxChars. */
const DEFAULT_MAX_CHARS = 220;

// ---------------------------------------------------------------------------
// Czech numerals
// ---------------------------------------------------------------------------

/** Cardinal unit words. Czech "one"/"two" agree with the counted noun's gender. */
const UNITS = {
  // Neutral counting form: what you say when reading a number on its own.
  count: ["", "jedna", "dva", "tři", "čtyři", "pět", "šest", "sedm", "osm", "devět"],
  // Masculine (tisíc, milion, stupeň, metr …).
  m: ["", "jeden", "dva", "tři", "čtyři", "pět", "šest", "sedm", "osm", "devět"],
  // Feminine (miliarda, tuna, hodina …).
  f: ["", "jedna", "dvě", "tři", "čtyři", "pět", "šest", "sedm", "osm", "devět"],
  // Neuter (euro, auto …): "jedno euro", "dvě eura".
  n: ["", "jedno", "dvě", "tři", "čtyři", "pět", "šest", "sedm", "osm", "devět"],
};

/** 10–19: one word each, no gender. */
const TEENS = [
  "deset",
  "jedenáct",
  "dvanáct",
  "třináct",
  "čtrnáct",
  "patnáct",
  "šestnáct",
  "sedmnáct",
  "osmnáct",
  "devatenáct",
];

/** Tens, indexed by the tens digit. */
const TENS = [
  "",
  "",
  "dvacet",
  "třicet",
  "čtyřicet",
  "padesát",
  "šedesát",
  "sedmdesát",
  "osmdesát",
  "devadesát",
];

/** Hundreds keep "sto"/"dvě stě"/"tři sta" … as fixed phrases. */
const HUNDREDS = ["", "sto", "dvě stě", "tři sta", "čtyři sta", "pět set", "šest set", "sedm set", "osm set", "devět set"];

/** Scale words with their plural forms; `gender` decides jeden/jedna inside the count. */
const SCALES = [
  { value: 1_000_000_000_000, gender: "m", few: "biliony", many: "bilionů", one: "bilion" },
  { value: 1_000_000_000, gender: "f", few: "miliardy", many: "miliard", one: "miliarda" },
  { value: 1_000_000, gender: "m", few: "miliony", many: "milionů", one: "milion" },
  { value: 1_000, gender: "m", few: "tisíce", many: "tisíc", one: "tisíc" },
];

/** Ordinal words 1–19 (masculine nominative, the default when reading "3."). */
const ORDINAL_ONES = [
  "",
  "první",
  "druhý",
  "třetí",
  "čtvrtý",
  "pátý",
  "šestý",
  "sedmý",
  "osmý",
  "devátý",
  "desátý",
  "jedenáctý",
  "dvanáctý",
  "třináctý",
  "čtrnáctý",
  "patnáctý",
  "šestnáctý",
  "sedmnáctý",
  "osmnáctý",
  "devatenáctý",
];

/** Ordinal tens: "dvacátý", "třicátý" … */
const ORDINAL_TENS = ["", "", "dvacátý", "třicátý", "čtyřicátý", "padesátý", "šedesátý", "sedmdesátý", "osmdesátý", "devadesátý"];

/** Genitive ordinals for dates: "dvacátého šestého". */
const ORDINAL_ONES_GEN = [
  "",
  "prvního",
  "druhého",
  "třetího",
  "čtvrtého",
  "pátého",
  "šestého",
  "sedmého",
  "osmého",
  "devátého",
  "desátého",
  "jedenáctého",
  "dvanáctého",
  "třináctého",
  "čtrnáctého",
  "patnáctého",
  "šestnáctého",
  "sedmnáctého",
  "osmnáctého",
  "devatenáctého",
];

/** Genitive ordinal tens: "dvacátého", "třicátého" … */
const ORDINAL_TENS_GEN = ["", "", "dvacátého", "třicátého", "čtyřicátého", "padesátého", "šedesátého", "sedmdesátého", "osmdesátého", "devadesátého"];

/** Genitive month names, as dates require. */
const MONTHS_GEN = [
  "ledna",
  "února",
  "března",
  "dubna",
  "května",
  "června",
  "července",
  "srpna",
  "září",
  "října",
  "listopadu",
  "prosince",
];

/**
 * Which case slot a count selects: exactly "one", the 2–4 range ("few"), or the
 * genitive plural every other count takes ("many"). 12–14 pattern like 5 (Czech
 * says "dvanáct korun", not "dvanáct koruny").
 */
function pluralKey(count) {
  const mod100 = Math.abs(count) % 100;
  const mod10 = Math.abs(count) % 10;
  if (count === 1) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
  return "many";
}

/** Pick the singular/dual/plural word from a set of forms. */
function pluralForm(count, forms) {
  return forms[pluralKey(count)];
}

/** 0–999 as words, with the gender of the unit digit. */
function belowThousand(value, gender) {
  const units = UNITS[gender] ?? UNITS.count;
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts = [];
  if (hundreds > 0) parts.push(HUNDREDS[hundreds]);
  if (rest > 0) {
    if (rest < 10) parts.push(units[rest]);
    else if (rest < 20) parts.push(TEENS[rest - 10]);
    else {
      const tens = TENS[Math.floor(rest / 10)];
      const unit = rest % 10;
      parts.push(unit > 0 ? `${tens} ${units[unit]}` : tens);
    }
  }
  return parts.join(" ");
}

/**
 * Cardinal number → Czech words.
 *
 * `gender` exists because "1 000 001" must read "jeden milion jeden" while
 * "1 000 001 korun" is read "jeden milion jedna koruna" — the numeral agrees with
 * what it counts, and this function is the only place that knows the count.
 */
export function numberToWords(value, gender = "count") {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "nula";
  if (n < 0) return `mínus ${numberToWords(-n, gender)}`;
  if (n > 9_999_999_999_999) return digitsToWords(String(n)); // beyond biliony: read digits

  let rest = n;
  const parts = [];
  for (const scale of SCALES) {
    const count = Math.floor(rest / scale.value);
    if (count === 0) continue;
    rest %= scale.value;
    if (count === 1) {
      // "tisíc", "milion", "miliarda" — Czech omits "jeden" here, and the money
      // example in the brief ("1 250 Kč" → "tisíc dvě stě padesát korun") depends
      // on that omission.
      parts.push(scale.one);
    } else {
      // 2–4 agree with the scale noun ("dva tisíce", "dvě miliardy"); 5+ takes the
      // counting form of the numeral because the scale noun is in genitive plural
      // ("dvacet jedna tisíc", not "dvacet jeden tisíc").
      const form = pluralKey(count);
      const gender = form === "few" ? scale.gender : "count";
      parts.push(`${belowThousand(count, gender)} ${scale[form]}`);
    }
  }
  if (rest > 0) parts.push(belowThousand(rest, gender));
  return parts.join(" ");
}

/** Digits read one by one: "nula pět", "dva nula dva šest". */
function digitsToWords(digits) {
  const names = ["nula", "jedna", "dva", "tři", "čtyři", "pět", "šest", "sedm", "osm", "devět"];
  return String(digits)
    .split("")
    .map((digit) => names[Number(digit)] ?? digit)
    .join(" ");
}

/** Ordinal 1–99 (or the round 100/1000) in nominative or genitive. */
function ordinalToWords(value, genitive = false, gender = "m") {
  const n = Math.trunc(Number(value));
  const ones = genitive ? ORDINAL_ONES_GEN : ORDINAL_ONES;
  const tens = genitive ? ORDINAL_TENS_GEN : ORDINAL_TENS;
  if (n === 0) return "nultý";
  if (n < 20) return ones[n];
  if (n < 100) {
    const ten = Math.floor(n / 10);
    const unit = n % 10;
    if (unit === 0) return tens[ten];
    // "dvacátý první" / "dvacátého prvního"
    const first = ones[unit];
    return `${tens[ten]} ${first}`;
  }
  if (n === 100) return genitive ? "stého" : "stý";
  if (n === 1000) return genitive ? "tisícího" : "tisící";
  return numberToWords(n, gender); // beyond 99 the ordinal form is rare enough to be honest about
}

// ---------------------------------------------------------------------------
// quantities: money, units, percentages
// ---------------------------------------------------------------------------

/** Units and currencies with the four Czech forms a spoken quantity needs. */
const QUANTITIES = [
  { id: "km/h", gender: "m", one: "kilometr v hodině", few: "kilometry v hodině", many: "kilometrů v hodině", gen: "kilometru v hodině" },
  { id: "m/s", gender: "m", one: "metr za sekundu", few: "metry za sekundu", many: "metrů za sekundu", gen: "metru za sekundu" },
  { id: "kWh", gender: "f", one: "kilowatthodina", few: "kilowatthodiny", many: "kilowatthodin", gen: "kilowatthodiny" },
  { id: "MWh", gender: "f", one: "megawatthodina", few: "megawatthodiny", many: "megawatthodin", gen: "megawatthodiny" },
  { id: "GWh", gender: "f", one: "gigawatthodina", few: "gigawatthodiny", many: "gigawatthodin", gen: "gigawatthodiny" },
  { id: "°C", gender: "m", one: "stupeň Celsia", few: "stupně Celsia", many: "stupňů Celsia", gen: "stupně Celsia" },
  { id: "°F", gender: "m", one: "stupeň Fahrenheita", few: "stupně Fahrenheita", many: "stupňů Fahrenheita", gen: "stupně Fahrenheita" },
  { id: "km", gender: "m", one: "kilometr", few: "kilometry", many: "kilometrů", gen: "kilometru" },
  { id: "cm", gender: "m", one: "centimetr", few: "centimetry", many: "centimetrů", gen: "centimetru" },
  { id: "mm", gender: "m", one: "milimetr", few: "milimetry", many: "milimetrů", gen: "milimetru" },
  { id: "nm", gender: "m", one: "nanometr", few: "nanometry", many: "nanometrů", gen: "nanometru" },
  { id: "kg", gender: "m", one: "kilogram", few: "kilogramy", many: "kilogramů", gen: "kilogramu" },
  { id: "mg", gender: "m", one: "miligram", few: "miligramy", many: "miligramů", gen: "miligramu" },
  { id: "ml", gender: "m", one: "mililitr", few: "mililitry", many: "mililitrů", gen: "mililitru" },
  { id: "KB", gender: "m", one: "kilobajt", few: "kilobajty", many: "kilobajtů", gen: "kilobajtu" },
  { id: "MB", gender: "m", one: "megabajt", few: "megabajty", many: "megabajtů", gen: "megabajtu" },
  { id: "GB", gender: "m", one: "gigabajt", few: "gigabajty", many: "gigabajtů", gen: "gigabajtu" },
  { id: "TB", gender: "m", one: "terabajt", few: "terabajty", many: "terabajtů", gen: "terabajtu" },
  { id: "kW", gender: "m", one: "kilowatt", few: "kilowatty", many: "kilowattů", gen: "kilowattu" },
  { id: "MW", gender: "m", one: "megawatt", few: "megawatty", many: "megawattů", gen: "megawattu" },
  { id: "GHz", gender: "m", one: "gigahertz", few: "gigahertzy", many: "gigahertzů", gen: "gigahertzu" },
  { id: "MHz", gender: "m", one: "megahertz", few: "megahertzy", many: "megahertzů", gen: "megahertzu" },
  { id: "kHz", gender: "m", one: "kilohertz", few: "kilohertzy", many: "kilohertzů", gen: "kilohertzu" },
  { id: "ms", gender: "f", one: "milisekunda", few: "milisekundy", many: "milisekund", gen: "milisekundy" },
  { id: "min", gender: "f", one: "minuta", few: "minuty", many: "minut", gen: "minuty" },
  { id: "px", gender: "m", one: "pixel", few: "pixely", many: "pixelů", gen: "pixelu" },
  { id: "km²", gender: "m", one: "kilometr čtvereční", few: "kilometry čtvereční", many: "kilometrů čtverečních", gen: "kilometru čtverečního" },
  { id: "m²", gender: "m", one: "metr čtvereční", few: "metry čtvereční", many: "metrů čtverečních", gen: "metru čtverečního" },
  { id: "m³", gender: "m", one: "metr krychlový", few: "metry krychlové", many: "metrů krychlových", gen: "metru krychlového" },
  { id: "t", gender: "f", one: "tuna", few: "tuny", many: "tun", gen: "tuny" },
  { id: "l", gender: "m", one: "litr", few: "litry", many: "litrů", gen: "litru" },
  { id: "g", gender: "m", one: "gram", few: "gramy", many: "gramů", gen: "gramu" },
  { id: "m", gender: "m", one: "metr", few: "metry", many: "metrů", gen: "metru" },
  { id: "W", gender: "m", one: "watt", few: "watty", many: "wattů", gen: "wattu" },
  { id: "V", gender: "m", one: "volt", few: "volty", many: "voltů", gen: "voltu" },
  { id: "A", gender: "m", one: "ampér", few: "ampéry", many: "ampérů", gen: "ampéru" },
  { id: "Hz", gender: "m", one: "hertz", few: "hertzy", many: "hertzů", gen: "hertzu" },
  { id: "s", gender: "f", one: "sekunda", few: "sekundy", many: "sekund", gen: "sekundy" },
  { id: "h", gender: "f", one: "hodina", few: "hodiny", many: "hodin", gen: "hodiny" },
];

/** Longest unit first: "min" must win over "m", "kWh" over "W". */
const UNIT_PATTERN = [...QUANTITIES]
  .sort((left, right) => right.id.length - left.id.length)
  .map((unit) => unit.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/** Currencies we can name, including the two symbols that show up in Czech text. */
const CURRENCIES = [
  { id: "Kč", gender: "f", one: "koruna", few: "koruny", many: "korun", gen: "koruny", subunit: { id: "haléř", few: "haléře", many: "haléřů" } },
  { id: "EUR", gender: "n", one: "euro", few: "eura", many: "eur", gen: "eura", subunit: { id: "cent", few: "centy", many: "centů" } },
  { id: "€", gender: "n", one: "euro", few: "eura", many: "eur", gen: "eura", subunit: { id: "cent", few: "centy", many: "centů" } },
  { id: "USD", gender: "m", one: "dolar", few: "dolary", many: "dolarů", gen: "dolaru", subunit: { id: "cent", few: "centy", many: "centů" } },
  { id: "$", gender: "m", one: "dolar", few: "dolary", many: "dolarů", gen: "dolaru", subunit: { id: "cent", few: "centy", many: "centů" } },
];

const CURRENCY_PATTERN = CURRENCIES.map((currency) => currency.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/** Percent takes the same case forms as a counted noun. */
const PERCENT_FORMS = { one: "procento", few: "procenta", many: "procent", gen: "procenta" };

/**
 * Parse the digit text of a quantity into an integer plus optional fraction.
 * Accepts Czech thousand separators (spaces) and both decimal marks, because the
 * same plug-in reads text copied from Czech (comma) and English (dot) sources.
 */
function parseDigits(raw) {
  let text = String(raw).replace(/[\s\u00A0\u2009]/g, "");
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(text)) text = text.replace(/[.,]/g, "");
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text);
  if (match === null) return { int: 0, frac: null };
  return { int: Number(match[1]), frac: match[2] ?? null };
}

/** Strip trailing separators from a captured amount; null when nothing valid is left. */
function cleanDigits(raw) {
  const text = String(raw ?? "")
    .replace(/[\s\u00A0]+/g, " ")
    .trim()
    .replace(/[.,;:]+$/, "")
    .trim();
  if (!/^\d[\d\s\u00A0.,]*$/.test(text)) return null;
  const { int, frac } = parseDigits(text);
  if (int === 0 && frac === null && !/\d/.test(text)) return null;
  return { text, int, frac };
}

/**
 * The numeral as spoken: "tisíc dvě stě padesát", "tři a půl", "tři celé pět".
 * `gender` is the gender of the counted noun, because "1 hodina" is "jedna
 * hodina" while "1 litr" is "jeden litr".
 */
function quantityWords(int, frac, gender = "count") {
  if (frac === null) return numberToWords(int, gender);
  if (int === 0 && frac === "5") return "půl";
  // "jeden a půl hodiny", "jeden a půl kilometru": Czech uses the masculine
  // "jeden" in this fixed construction regardless of the counted noun.
  if (frac === "5") return `${numberToWords(int, "m")} a půl`;
  // "3,14" is "tři celé čtrnáct"; "1,05" is "jedna celá nula pět" — a leading zero
  // means the fraction is a digit sequence, not a number.
  const fractionWords = frac.length <= 2 && !frac.startsWith("0") ? numberToWords(Number(frac)) : digitsToWords(frac);
  // "jedna celá" and "nula celá" already carry the numeral; only 2+ needs one.
  if (int === 1) return `jedna celá ${fractionWords}`;
  if (int === 0) return `nula celá ${fractionWords}`;
  return `${numberToWords(int, gender)} celé ${fractionWords}`;
}

/** Which case form a counted noun takes after this quantity. */
function quantityForm(int, frac) {
  if (frac !== null) return "gen"; // "1,5 kilometru", "2,5 kilometru"
  return pluralForm(int, { one: "one", few: "few", many: "many" });
}

/** "5 km" → "pět kilometrů", "1 km" → "jeden kilometr", "1,5 km" → "jeden a půl kilometru". */
function quantityPhrase(rawNumber, quantity) {
  const { int, frac } = parseDigits(rawNumber);
  const form = quantityForm(int, frac);
  return `${quantityWords(int, frac, quantity.gender ?? "m")} ${quantity[form]}`;
}

/** "1 250 Kč" → "tisíc dvě stě padesát korun"; with haléře when a 2-digit fraction is given. */
function moneyPhrase(rawNumber, currency) {
  const { int, frac } = parseDigits(rawNumber);
  const form = quantityForm(int, frac);
  const main = `${quantityWords(int, frac, currency.gender ?? "f")} ${currency[form]}`;
  if (frac !== null && frac.length === 2 && currency.subunit !== undefined) {
    const subunits = Number(frac);
    if (subunits > 0) {
      // "1 250,50 Kč" → "tisíc dvě stě padesát korun padesát haléřů": with a
      // subunit the main noun goes to genitive plural, not the "gen" of "1,5 koruny".
      const subunitForm = pluralForm(subunits, currency.subunit);
      return `${numberToWords(int)} ${pluralForm(int, currency)} ${numberToWords(subunits)} ${subunitForm}`;
    }
  }
  return main;
}

// ---------------------------------------------------------------------------
// Markdown, code, links
// ---------------------------------------------------------------------------

/** Remove fenced code blocks, announcing the skip exactly once. */
function stripFences(text) {
  let announced = false;
  const swallow = () => {
    if (announced) return "\n";
    announced = true;
    return "\nblok kódu\n";
  };
  let out = text.replace(/(^|\n)([ \t]*)(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|$)/g, (match, lead) =>
    `${lead === "\n" ? "\n" : ""}${swallow()}`,
  );
  // An unclosed fence (a message still streaming in) hides the rest of the text.
  out = out.replace(/(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n?[\s\S]*$/, (match, lead) =>
    `${lead === "\n" ? "\n" : ""}${swallow()}`,
  );
  return out;
}

/** Drop a Markdown table's separator row or turn a row into "hodnota, hodnota". */
function tidyTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return line;
  if (/^[|\s:-]+$/.test(trimmed) && trimmed.includes("-")) return ""; // |---|---|
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  if (cells.length < 2) return line;
  return cells.join(", ");
}

/** Strip Markdown syntax while keeping the words a listener needs. */
function stripMarkdown(text, { code = true } = {}) {
  let out = text;
  if (code) out = stripFences(out);

  // Horizontal rules before list bullets: "---" is a rule, not a bullet.
  out = out.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");

  // Tables, line by line.
  out = out
    .split("\n")
    .map((line) => tidyTableRow(line))
    .join("\n");

  // Headings (leading # and the optional closing #'s).
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  out = out.replace(/[ \t]+#+[ \t]*$/gm, "");

  // Images are decoration; their alt text is usually a file name.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

  // Links keep their text; the URL is handled by the URL pass.
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  out = out.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, "");

  // Emphasis and strikethrough markers around words, not inside identifiers.
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  out = out.replace(/(^|[\s(„"'*])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1$2");
  out = out.replace(/(^|[\s(„"'])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, "$1$2");

  // Blockquotes, list bullets and ordered-list markers.
  out = out.replace(/^[ \t]*>[ \t]?/gm, "");
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  // "26. 10. 2026" starts like a list item but continues with a digit — keep it.
  out = out.replace(/^[ \t]*\d{1,2}[.)][ \t]+(?!\d)/gm, "");

  if (code) {
    // Inline code: drop the backticks, keep the identifier — short names are
    // spoken as words and often mean something ("npm test", "useState").
    out = out.replace(/``([^`]+)``/g, "$1");
    out = out.replace(/`([^`]+)`/g, "$1");
  }
  return out;
}

/** Turn URLs into "odkaz" or, for a short bare host, the host itself. */
function convertUrls(text) {
  let out = text;
  // E-mail addresses first: they contain a dot and a word@word shape a URL rule
  // would otherwise leave half-converted.
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "e-mail");

  const replaceUrl = (raw) => {
    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const host = withoutScheme.split(/[\/?#]/)[0] ?? "";
    const rest = withoutScheme.slice(host.length);
    const hasPath = /[\/?#]/.test(rest) && !/^\/?$/.test(rest);
    if (!hasPath && host.length > 0 && host.length <= 24) return host;
    return "odkaz";
  };

  out = out.replace(/\b(?:https?|ftp):\/\/[^\s<>()[\]"']+/gi, (match) => replaceUrl(match.trim()));
  out = out.replace(/\bwww\.[^\s<>()[\]"']+/gi, (match) => replaceUrl(match.trim()));
  return out;
}

/**
 * File paths are noise when read aloud; only a bare file name survives.
 *
 * The trailing punctuation is put back deliberately: "/tmp/app.js." ends a
 * sentence, and a path pattern that eats the final dot turns a sentence boundary
 * into a silent run-on.
 */
function convertPaths(text) {
  const replacePath = (match) => {
    const trimmed = match.replace(/[.,;:!?]+$/, "");
    const tail = match.slice(trimmed.length);
    return `cesta k souboru${tail}`;
  };
  let out = text;
  // Windows: C:\Users\…
  out = out.replace(/\b[A-Za-z]:\\[^\s"'<>|]+/g, replacePath);
  // POSIX-ish paths with at least two segments (~/, ./, ../ or /absolute).
  out = out.replace(/(?:~\/|\.\.?\/|\/)[\w.@%+-]+(?:\/[\w.@%+-]+)+/g, replacePath);
  return out;
}

/** Remove emoji and pictographs; their names are never what the sender meant. */
function stripEmoji(text) {
  return text.replace(
    /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2022}\u{25AA}-\u{25FE}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu,
    "",
  );
}

// ---------------------------------------------------------------------------
// numbers, dates, times, ranges
// ---------------------------------------------------------------------------

/** "26. 10. 2026" and friends → "dvacátého šestého října dva tisíce dvacet šest". */
function datePhrase(day, month, year) {
  const dayNumber = Number(day);
  const monthNumber = Number(month);
  if (!Number.isFinite(dayNumber) || dayNumber < 1 || dayNumber > 31) return null;
  if (!Number.isFinite(monthNumber) || monthNumber < 1 || monthNumber > 12) return null;
  const parts = [ordinalToWords(dayNumber, true), MONTHS_GEN[monthNumber - 1]];
  if (year !== undefined) {
    const yearNumber = Number(year);
    if (!Number.isFinite(yearNumber)) return null;
    parts.push(numberToWords(yearNumber));
  }
  return parts.join(" ");
}

/** All digit-to-word rules for Czech, in the only order that stays correct. */
function convertNumbers(text) {
  let out = text;

  // 1. Dates first: every later rule would happily eat their parts.
  out = out.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, year, month, day) => {
    const phrase = datePhrase(day, month, year);
    return phrase ?? match;
  });
  out = out.replace(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/g, (match, day, month, year) => {
    const phrase = datePhrase(day, month, year);
    return phrase ?? match;
  });
  out = out.replace(/\b(\d{1,2})\.\s*(\d{1,2})\.(?!\d)/g, (match, day, month) => {
    const phrase = datePhrase(day, month);
    return phrase ?? match;
  });

  // 2. Clock times: "14:30" → "čtrnáct třicet", "14:00" → "čtrnáct hodin".
  out = out.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (match, hours, minutes) => {
    const minuteNumber = Number(minutes);
    const hourWords = numberToWords(Number(hours));
    if (minuteNumber === 0) return `${hourWords} hodin`;
    if (minuteNumber < 10) return `${hourWords} nula ${numberToWords(minuteNumber)}`;
    return `${hourWords} ${numberToWords(minuteNumber)}`;
  });

  // 3. Money before units: "tis. Kč" and "1 250 Kč" must not be read as numbers.
  out = out.replace(
    new RegExp(`\\b(\\d[\\d\\s\\u00A0]*)\\s*tis\\.?\\s*(${CURRENCY_PATTERN})`, "g"),
    (match, raw, currencyId) => {
      const currency = CURRENCIES.find((entry) => entry.id === currencyId);
      const { int, frac } = parseDigits(raw);
      if (currency === undefined || frac !== null) return match;
      return quantityPhrase(String(int * 1000), currency);
    },
  );

  for (const currency of CURRENCIES) {
    const id = currency.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "1 250 Kč" — the currency follows the amount.
    const AMOUNT = "(\\d(?:[\\d\\s\\u00A0]*\\d)?(?:[.,]\\d+)?)";
    out = out.replace(new RegExp(`\\b${AMOUNT}\\s*${id}`, "g"), (match, raw) => {
      const digits = cleanDigits(raw);
      return digits === null ? match : moneyPhrase(digits.text, currency);
    });
    // "Kč 1 250" — the amount follows the currency (how the DoD example is written).
    out = out.replace(new RegExp(`${id}\\s*${AMOUNT}`, "g"), (match, raw) => {
      const digits = cleanDigits(raw);
      return digits === null ? match : moneyPhrase(digits.text, currency);
    });
  }

  // 3b. A number with a scale abbreviation is a quantity, not "dva milionů":
  // "2 mld. lidí" → "dvě miliardy lidí". Money with "tis. Kč" is already gone above.
  out = out.replace(/(\d+(?:[.,]\d+)?)\s*(mil|mld|tis)\.?(?![\p{L}])/giu, (match, raw, scaleId) => {
    const { int, frac } = parseDigits(raw);
    if (frac !== null) return match;
    const factor = { tis: 1_000, mil: 1_000_000, mld: 1_000_000_000 }[scaleId.toLowerCase()];
    if (factor === undefined) return match;
    return numberToWords(int * factor);
  });

  // 4. Ranges, with an optional unit that agrees with the upper bound.
  out = out.replace(
    new RegExp(
      // The optional unit carries its own whitespace: a bare `\s*(unit)?\b`
      // swallows the space after "10–20" and glues the next word onto "dvacet".
      `(\\d+(?:[.,]\\d+)?)\\s*[–—‑-]\\s*(\\d+(?:[.,]\\d+)?)(?:\\s*(${UNIT_PATTERN}))?\\b`,
      "g",
    ),
    (match, low, high, unitId) => {
      const unit = unitId === undefined ? undefined : QUANTITIES.find((entry) => entry.id === unitId);
      const lower = parseDigits(low);
      if (unit === undefined) {
        const upper = parseDigits(high);
        return `${quantityWords(lower.int, lower.frac)} až ${quantityWords(upper.int, upper.frac)}`;
      }
      return `${quantityWords(lower.int, lower.frac, unit.gender ?? "m")} až ${quantityPhrase(high, unit)}`;
    },
  );

  // 5. Percent.
  out = out.replace(/(\d+(?:[.,]\d+)?)\s*%/g, (match, raw) => {
    const { int, frac } = parseDigits(raw);
    return `${quantityWords(int, frac)} ${PERCENT_FORMS[quantityForm(int, frac)]}`;
  });

  // 6. Units: "5 km", "20 °C", "300 ms".
  out = out.replace(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`, "g"), (match, raw, unitId) => {
    const unit = QUANTITIES.find((entry) => entry.id === unitId);
    if (unit === undefined) return match;
    return quantityPhrase(raw, unit);
  });

  // 7. Grouped numbers, decimals, then ordinals, then bare integers.
  //
  // Grouping must precede the ordinal rule: "2 500 000." ends with a group of
  // three zeros, and a dot rule applied first reads that group as "nultý". Once
  // the grouped number is words, no digits are left for the ordinal rule to eat.
  out = out.replace(/(?<![\d.,])(\d{1,3}(?:[ \u00A0\u2009]\d{3})+)(?![\d])/g, (match) => {
    const { int, frac } = parseDigits(match);
    return quantityWords(int, frac);
  });
  out = out.replace(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+)(?![\d.,])/g, (match) => {
    const { int, frac } = parseDigits(match);
    return quantityWords(int, frac);
  });
  out = out.replace(/(?<![\d.,])(\d{1,3}(?:,\d{3})+)(?![\d.,])/g, (match) => {
    const { int, frac } = parseDigits(match);
    return quantityWords(int, frac);
  });
  out = out.replace(/(?<![\d.,])(\d+)[.,](\d+)(?![\d])/g, (match, intText, fracText) => {
    if (intText.length > 1 && intText.startsWith("0")) return match;
    return quantityWords(Number(intText), fracText);
  });
  // Ordinals: "3." → "třetí". Digits embedded in a group are already words.
  out = out.replace(/\b(\d{1,3})\.(?![\d])/g, (match, raw) => ordinalToWords(Number(raw)));
  out = out.replace(/\b(\d+)\b/g, (match) => numberToWords(Number(match)));

  return out;
}

// ---------------------------------------------------------------------------
// abbreviations and English loanwords
// ---------------------------------------------------------------------------

/**
 * Czech abbreviations, longest first so "tzn." cannot be read as "tzn" + "."
 * These are expanded *after* the number rules, so "1 250 Kč" takes the money path
 * ("tisíc dvě stě padesát korun") instead of the bare "Kč" → "korun" one.
 */
const ABBREVIATIONS = [
  // [source (regex text), words, flags]. Sources are wrapped in Unicode-aware
  // boundaries below: `\b` is ASCII-only, so `\bč\.` would never match "č." —
  // the exact bug that left Czech abbreviations unexpanded on a Czech string.
  ["např\\.", "například", "iu"],
  ["např", "například", "iu"],
  ["napod\\.", "napodobení", "iu"],
  ["tzn\\.", "to znamená", "iu"],
  ["tj\\.", "to je", "iu"],
  ["cca\\.?", "přibližně", "iu"],
  ["atd\\.", "a tak dále", "iu"],
  ["apod\\.", "a podobně", "iu"],
  ["resp\\.", "respektive", "iu"],
  ["mj\\.", "mimo jiné", "iu"],
  ["popř\\.", "popřípadě", "iu"],
  ["č\\.", "číslo", "iu"],
  ["str\\.", "strana", "iu"],
  ["odst\\.", "odstavec", "iu"],
  ["mil\\.", "milionů", "iu"],
  ["mld\\.", "miliard", "iu"],
  ["tis\\.", "tisíc", "iu"],
  ["Kč", "korun", "u"],
  ["MB", "megabajtů", "u"],
  ["GB", "gigabajtů", "u"],
  ["KB", "kilobajtů", "u"],
  ["TB", "terabajtů", "u"],
  ["AI", "á í", "u"],
  ["API", "á pé í", "u"],
  ["URL", "url", "u"],
  ["HTTP", "há té té pé", "u"],
  ["JSON", "džejson", "u"],
  ["CLI", "cé el í", "u"],
  ["UI", "u í", "u"],
  ["UX", "u ex", "u"],
  ["PDF", "pé dé ef", "u"],
  ["HTML", "há té em el", "u"],
  ["CSS", "cé es es", "u"],
  ["GPU", "gé pé ú", "u"],
  ["CPU", "cé pé ú", "u"],
  ["RAM", "ram", "u"],
];

/**
 * A word-boundary pattern that also works around Czech letters.
 *
 * WHY NOT `\b`: JavaScript's `\b` is defined on ASCII word characters, so
 * "č." has no boundary before "č" and "Kč" has none after "č". Both silently
 * failed to expand, which is precisely the case this file exists for.
 */
function abbreviationPattern(source, flags) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, `g${flags}`);
}

/**
 * Expand Czech abbreviations and acronyms.
 *
 * Replacement is always lowercase: the output is fed to a TTS engine, whose
 * prosody ignores case, and the alternative (guessing whether this occurrence
 * started a sentence) produced half-capitalised acronyms like "Url" mid-sentence.
 */
function expandAbbreviations(text) {
  let out = text;
  for (const [source, words, flags] of ABBREVIATIONS) {
    out = out.replace(abbreviationPattern(source, flags), words);
  }
  // A bare percent sign with no number left in front of it.
  out = out.replace(/\s*%/g, " procent");
  return out;
}

/**
 * English words that a Czech voice mangles. Mapping them is not translation: the
 * listener hears Czech, so a Czech phonetic spelling is the closest thing to the
 * word they would say aloud themselves.
 */
const ENGLISH = [
  ["pull request", "pul rikvest"],
  ["workflow", "vérkflou"],
  ["feedback", "fídbek"],
  ["deadline", "dedlajn"],
  ["software", "softvér"],
  ["hardware", "hardvér"],
  ["release", "rilís"],
  ["deploy", "deploj"],
  ["update", "apdejt"],
  ["commit", "komit"],
  ["online", "onlajn"],
  ["email", "ímejl"],
  ["issue", "išů"],
  ["merge", "merg"],
  ["feature", "fíčr"],
  ["cache", "keš"],
  ["thread", "thred"],
  ["token", "token"],
  ["prompt", "prompt"],
  ["model", "model"],
  ["bug", "bag"],
];

/** Rewrite English loanwords phonetically for a Czech voice. */
function transliterateEnglish(text) {
  let out = text;
  for (const [latin, phonetic] of ENGLISH) {
    const pattern = new RegExp(`\\b${latin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    out = out.replace(pattern, phonetic);
  }
  return out;
}

// ---------------------------------------------------------------------------
// final tidy
// ---------------------------------------------------------------------------

/** Collapse the debris the earlier passes leave behind. */
function tidy(text) {
  let out = text;
  out = out.replace(/\u200B|\uFEFF/g, "");
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/ *\n */g, "\n");
  out = out.replace(/\n{2,}/g, "\n");
  out = out.replace(/\s+([,.;:!?…)\]])/g, "$1");
  out = out.replace(/\(\s+/g, "(");
  out = out.replace(/\.{3,}/g, "…");
  out = out.replace(/([,;:])\s*\1+/g, "$1");
  out = out.replace(/([,;:])(?=[^\s\d])/g, "$1 ");
  out = out.replace(/\s+$/gm, "");
  out = out.replace(/^[ \t]+/gm, "");
  out = out.replace(/\n{2,}/g, "\n");
  return out.trim();
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Turn agent output into something a Czech voice can read.
 *
 * @param {string} text
 * @param {{language?: "cs"|"en", numbers?: boolean, abbreviations?: boolean,
 *   urls?: boolean, code?: boolean, markdown?: boolean, english?: boolean,
 *   emoji?: boolean}} [options]
 * @returns {string}
 */
export function normalizeForSpeech(text, options = {}) {
  let out = String(text ?? "");
  if (out.trim().length === 0) return "";

  const language = options.language === "en" ? "en" : "cs";
  const on = (key) => options[key] !== false;

  // Normalise the whitespace characters that Markdown/editors insert before any
  // pattern tries to match a space.
  out = out.replace(/\r\n?/g, "\n").replace(/[\u00A0\u2007\u202F\u2009\u200A\u200B\uFEFF]/g, " ");

  if (on("markdown")) out = stripMarkdown(out, { code: on("code") });
  else if (on("code")) out = stripFences(out);

  if (on("urls")) out = convertUrls(out);
  if (on("urls")) out = convertPaths(out);
  if (on("emoji")) out = stripEmoji(out);

  if (language === "cs") {
    // The order here is the point; see the header comment.
    if (on("numbers")) out = convertNumbers(out);
    if (on("abbreviations")) out = expandAbbreviations(out);
    if (on("english")) out = transliterateEnglish(out);
  }

  return tidy(out);
}

// ---------------------------------------------------------------------------
// sentences
// ---------------------------------------------------------------------------

/** Dotted abbreviations that must not end a sentence when splitting raw text. */
const SPLIT_SAFE_ABBREVIATIONS = new Set([
  "např",
  "tj",
  "tzn",
  "atd",
  "apod",
  "resp",
  "mj",
  "popř",
  "č",
  "str",
  "odst",
  "mil",
  "mld",
  "tis",
  "cca",
  "prof",
  "ing",
  "mgr",
  "mudr",
  "dr",
  "ph.d",
  "s.r.o",
  "a.s",
  "spol",
  "ul",
  "kupř",
  "event",
  "tzv",
  "aj",
  "ap",
]);

/** True when the punctuation at `index` really ends a sentence. */
function isSentenceEnd(text, index) {
  const char = text[index];
  const previous = text.slice(0, index).trimEnd();
  const token = /([\p{L}\p{N}.]+)$/u.exec(previous)?.[1] ?? "";
  const dotless = token.replace(/^\.+/, "").toLowerCase();

  if (char === "…") return false; // ellipsis: a pause, not a boundary
  if (char === ".") {
    // A run of dots ("...") is one terminator; only its last dot may end a
    // sentence, otherwise the loop emits "." as a sentence of its own.
    if (text[index + 1] === ".") return false;
    // Decimal "3,5" or "3.5": a dot between digits never ends a sentence.
    if (/\d$/.test(previous) && /^\d/.test(text.slice(index + 1))) return false;
    // "3." is list numbering when a lowercase word follows, and an ordinal when
    // the sentence really ends or a new one starts.
    if (/^\d+$/.test(token)) {
      const rest = text.slice(index + 1);
      const next = /^[\s]*([\p{L}])/u.exec(rest)?.[1];
      if (next !== undefined && next === next.toLowerCase() && next !== next.toUpperCase()) return false;
    }
    if (SPLIT_SAFE_ABBREVIATIONS.has(dotless)) return false;
    // A lowercase continuation is almost always an abbreviation or a list item.
    const rest = text.slice(index + 1);
    const next = /^[\s]*([\p{L}])/u.exec(rest)?.[1];
    if (next !== undefined && next === next.toLowerCase() && next !== next.toUpperCase()) return false;
  }
  return true;
}

/** Split one paragraph on real sentence boundaries. */
function splitParagraph(paragraph) {
  const sentences = [];
  let start = 0;
  for (let index = 0; index < paragraph.length; index += 1) {
    const char = paragraph[index];
    if (char !== "." && char !== "!" && char !== "?" && char !== "…") continue;
    if (!isSentenceEnd(paragraph, index)) continue;
    // Consume a run of terminators ("?!", "...") and closing quotes, so the next
    // chunk starts at a word and never at a stray dot.
    let end = index + 1;
    while (end < paragraph.length && /["'”’)\].!?…]/.test(paragraph[end])) end += 1;
    const sentence = paragraph.slice(start, end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    start = end;
    while (start < paragraph.length && /\s/.test(paragraph[start])) start += 1;
    index = start - 1;
  }
  const tailText = paragraph.slice(start).trim();
  if (tailText.length > 0) sentences.push(tailText);
  return sentences;
}

/** Cut an over-long sentence at clause boundaries, never inside a word. */
function chunkSentence(sentence, limit) {
  const chunks = [];
  let rest = sentence;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const separator of [", ", "; ", ": ", " – ", " — ", " - "]) {
      const index = window.lastIndexOf(separator);
      if (index > limit * 0.35 && index + separator.length <= limit) {
        cut = Math.max(cut, index + separator.length);
      }
    }
    if (cut <= 0) {
      const index = window.lastIndexOf(" ");
      if (index > 0) cut = index + 1;
    }
    if (cut <= 0) {
      // One word longer than the limit: cut at the next space to guarantee
      // progress. The chunk may exceed `limit`; a split word would be worse.
      const index = rest.indexOf(" ", limit);
      cut = index === -1 ? rest.length : index + 1;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Split text into speakable chunks of at most `maxChars` characters.
 *
 * Chunks are cut at sentence ends first and at clause boundaries second, so each
 * synthesis request stays one breath. Nothing is reordered, merged or dropped:
 * concatenating the result with single spaces gives the input back.
 *
 * @param {string} text
 * @param {number} [maxChars=220]
 * @returns {string[]}
 */
export function splitSentences(text, maxChars = DEFAULT_MAX_CHARS) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (source.length === 0) return [];
  const limit = Number.isFinite(maxChars) && maxChars >= 20 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;

  const chunks = [];
  for (const paragraph of source.split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;
    for (const sentence of splitParagraph(trimmed)) {
      for (const chunk of chunkSentence(sentence, limit)) chunks.push(chunk);
    }
  }
  return chunks;
}
