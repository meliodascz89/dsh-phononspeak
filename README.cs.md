# dsh-phononspeak

> **Language:** [English](README.md) · [Česky](README.cs.md)

Lokální hlasový kanál pro agenta v DeepSeek Harness, s češtinou jako výchozí. Agent může přečíst
krátké shrnutí své odpovědi nahlas a může si tě zavolat k počítači, když potřebuje rozhodnutí — větou
nahlas, notifikací v macOS a bannerem s tlačítkem „Jsem tady". Řeč syntetizuje tvůj stroj jedním ze
čtyř enginů, přehrávání jde přes frontu s prioritami, dá se zastavit a nastavuje se na vlastní stránce
Nastavení přímo v Harnessu. Žádná cloudová TTS, žádný API klíč, žádný upload textu.

## Proč

Agent, který pracuje několik minut v kuse, je špatná věc na to, aby ses na něj díval. Plugin existuje
pro dva okamžiky a nic jiného:

| Úloha | Co se stane | Proč to má cenu |
|---|---|---|
| **Přečíst odpověď nahlas** | Model zavolá `dsh_phononspeak action=summary` s českým shrnutím v 1–3 větách; plugin ho přečte | Pracuješ rukama a výsledek stejně uslyšíš |
| **Zavolat tě k počítači** | Agent potřebuje schválení nebo odpověď → krátká věta nahlas, notifikace v macOS, banner s „Jsem tady" | Nemusíš sledovat obrazovku, a přesto otázku nezmeškáš |

Všechno ostatní tu schválně není: plugin nepředčítá uvažování, nečte kód, URL ani dlouhé seznamy a
mlčí, dokud nemá co říct.

## Funkce

- **Čtení shrnutí** — jedno volání nástroje, jeden krátký český odstavec. Volitelně po každé odpovědi
  (`autoSummary`), což zároveň zapne odpovídající instrukci v systémovém promptu.
- **Text připravený k předčítání** — před syntézou se odstraní Markdown a bloky kódu (odstraněný blok se
  oznámí, nikdy se nezamlčí), URL a cesty k souborům se převedou na slova, emoji zmizí, čísla, data,
  peníze a jednotky se vysloví jako české číslovky se správným rodem, tečkované české zkratky se rozepíšou
  a anglické termíny se přepíšou foneticky. Výsledek se rozdělí na věty o nejvýš 220 znacích.
- **Volání k počítači** — věta nahlas, notifikace v macOS (`osascript`) a banner v UI s tlačítkem
  „Jsem tady". Volitelně opakování po 15, 30 nebo 60 sekundách, dokud volání nepotvrdíš.
- **Skutečná fronta** — pozornost > otázka > shrnutí > ruční > test. Nic se nepřekrývá; dvě oznámení
  v jedné sekundě už si nepřekážejí.
- **Skutečné zastavení** — `action=stop` přeruší běžící syntézu, ukončí přehrávací proces, vyprázdní
  frontu a zruší opakování. Úlohy z doby před zastavením se zahazují, neobnovují.
- **Čtyři enginy včetně licence** — ve výchozím stavu Supertonic 3, dále Piper, Pocket TTS Czech a
  macOS `say`. Každý engine nese svou licenci do UI a `say` se drží mimo automatický řetěz mimo osobní
  nekomerční užití.
- **Klonované hlasy (opt-in)** — Pocket TTS Czech klonuje z wav souboru cílového hlasu; UI si před
  uložením cesty vyžádá výslovné potvrzení práv.
- **Vše lokálně** — text neopustí stroj. Zvuk se vydává z originu Harnessu přes URL s podporou Range,
  takže stránka umí pauzu i přeskakování.
- **Vlastní UI** — stránka Nastavení jménem Phononspeak, plovoucí mini přehrávač, vlastní karta
  nástroje a správa klonovaných hlasů.

## Instalace

Plugin se instaluje jako bundle nástrojem `plugin_manager`. Instalace bundlu přidá jeden řádek v
hostiteli (`cordis.patch.yml` → `phononspeak`); webovou polovinu objeví Harness z `package.json`
(`dsh.client`).

**Z lokálního checkoutu** (vývoj):

```
plugin_manager action="install_bundle" target="/absolutni/cesta/k/dsh-phononspeak"
```

Cesta musí být **absolutní**. Relativní cesta je odmítnuta.

**Z Gitu**, připíchnuto na commit:

```
plugin_manager action="install_bundle" target="git+https://github.com/meliodascz89/dsh-phononspeak.git#<40-hex-commit>"
```

Použij plný 40znakový SHA commitu. Repozitář pluginu je
`https://github.com/meliodascz89/dsh-phononspeak`.

**Z trhu pluginů**: katalog je `index.json` formátu 1 na GitHub Pages téhož repozitáře. Záznam má
`git` zdroj připíchnutý na SHA commitu (podporován je i `npm` zdroj); `file:` zdroje a názvy větví
index vyjádřit neumí a URL indexu musí být konečná, protože redirect fetch rozbije.

Nainstalovaný bundle se aktivuje v běžícím profilu. Pokud se webová polovina instalovala poprvé,
obnov okno Harnessu, aby se načetl klientský modul.

### Požadavky

| Požadavek | Proč |
|---|---|
| DeepSeek Harness s `@deepseek-ai/dsh-tools >=0.1.1-rc.2 <0.3.0` | Peer range, kterou tento balíček deklaruje. |
| Node.js >= 22 | `engines.node` v `package.json`. |
| macOS | Kvůli `say`, `afplay` a `osascript`. Na Linuxu a Windows funguje jen přehrávač ve stránce a enginy, které nejsou od Applu. |
| Python 3.10 nebo novější s `venv` | Jen pro Supertonic a Pocket TTS Czech. Piper a `say` Python nepotřebují. Interpreter se hledá a jeho verze se ověřuje ještě před vytvořením virtualenvu, protože `python3` shim, který hlásí 3.8, postaví půlku závislostí a pak selže. |

Dva detaily balíčku rozhodují o tom, jestli se plugin vůbec načte:

- Peer range je schválně otevřená. Loader Harnessu plugin s nesplněnou peer range **potichu přeskočí**
  — příkladem jsou rozsahy `^0.1.0-rc.6` u starších `dsh-agent-voice` a `dsh-voice-studio`: na
  runtime 0.2.x nesedí, takže se ty pluginy vůbec nespustí a nikam se to nezapíše.
- Balíček nemá žádný `prepare` ani `install` skript. pnpm pouští build skripty u git závislostí až po
  výslovném schválení, takže se dodávají hotové `lib/*.js`.

## První spuštění

Výchozí engine je `auto`, který prochází **supertonic → piper → pocket → say**. Použijí se jen enginy,
které na stroji skutečně jsou, a `say` je odmítnutý, dokud je zapnutý `commercialMode` a vypnutý
`allowPersonalVoice` — i když ho vybereš výslovně.

Když v řetězu není použitelný žádný engine a `autoProvision` je zapnutý (výchozí stav), host na pozadí
připraví Supertonic: Python virtualenv a model, zhruba **0,5 GB** stahování. Průběh ukazuje stránka
Nastavení a `GET /dsh-phononspeak/setup`; host to zkouší nejvýš jednou za hodinu, aby offline stroj
nezatěžoval pořád dokola.

Bez sítě plugin prostě použije to, co už je nainstalované (binárku Piper a hlasy, nebo `say` na macOS),
a u každého chybějícího enginu řekne, proč není k dispozici — místo aby úlohu shodil.

Výsledek ověříš takto:

```
dsh_phononspeak action=status
```

## Použití

### Nástroj

Jeden modelový nástroj, `dsh_phononspeak`.

| Akce | Co dělá |
|---|---|
| `summary` | Přečte české shrnutí odpovědi v 1–3 větách. Zamýšlené použití pluginu. |
| `attention` | Zavolá uživatele: přečte větu, zobrazí notifikaci a banner, volitelně opakuje do potvrzení. |
| `speak` | Přečte jiný text, který se má říct záměrně. |
| `stop` | Přeruší syntézu i přehrávání, vyprázdní frontu a zruší opakování. |
| `status` | Aktuální nastavení, dostupnost enginů, délka fronty, co právě hraje. |
| `voices` | Plochý seznam hlasů napříč dostupnými enginy plus záznamy enginů. |
| `install` | Připraví engine (venv, stažení modelu). Vrací se hned; průběh se dotazuje. |
| `ack` | Potvrdí čekající volání k počítači a zastaví jeho opakování. |

Parametry: `action` (povinný), `text`, `voice`, `engine`. Popis nástroje vypisuje povolené názvy akcí,
protože DSL nástrojů nemá typ `enum`.

Výsledek je JSON:

```json
{
  "ok": true,
  "kind": "summary",
  "id": "ps-1761480000000-a1b2c3",
  "engine": "auto",
  "voice": "M1",
  "segments": 2,
  "shortened": false,
  "text": "Přepis je hotový a titulky jsou uložené.",
  "output": "browser"
}
```

`segments` je počet vět, na které se úloha rozdělila, `text` je normalizovaný (a případně zkrácený)
text, který se skutečně zařadil do fronty, a `shortened` říká, jestli ho ořízl limit `maxChars`.
`engine` a `voice` opakují nastavení z okamžiku zařazení — engine, který skutečně mluvil, hlásí
`lastEngine` v `GET /dsh-phononspeak/state`.

Příklady:

```
dsh_phononspeak action=summary text="Přepis je hotový. Našel jsem tři mluvčí a uložil titulky."
dsh_phononspeak action=attention text="Potřebuji od tebe schválení mazání souborů."
dsh_phononspeak action=speak text="Zkouška hlasu." engine=piper
dsh_phononspeak action=stop
```

### Co se říká modelu

Sekce systémového promptu (`phononspeak`, pořadí 410) se vkládá jen tehdy, když je funkce zapnutá —
tichý plugin tedy nestojí žádné tokeny. Říká modelu, aby mluvil česky, držel každou zprávu v jednom
krátkém odstavci a nikdy nepředčítal uvažování, průběh, kód, URL ani dlouhé seznamy. Když je
`autoSummary` zapnuté, sekce doplní: po každé dokončené odpovědi zavolej `action=summary` s českým
shrnutím o jedné až třech větách (max ~300 znaků); když je vypnuté, model čte shrnutí jen na výslovné
přání. Dokud je zapnutý komerční režim bez opt-inu pro osobní hlas, model dostane i instrukci
nepoužívat hlas `say` z macOS.

### V UI

- **Nastavení → Phononspeak** — vlastní stránka se všemi poli níže, kartami enginů s licencí a
  velikostí, tlačítky Instalovat/Opravit a správou klonovaných hlasů.
- **Plovoucí mini přehrávač** — play/pause/stop, co právě mluví, a fronta. Když prohlížeč odmítne
  spustit přehrávání sám (autoplay policy), přehrávač nabídne tlačítko **Přehrát**, místo aby tiše selhal.
- **Karta nástroje** — volání `dsh_phononspeak` se vykreslí jako vlastní karta místo syrového JSON,
  s tlačítkem „Přehrát znovu", které přehraje poslední mluvený text.
- **Banner volání** — „Agent tě volá" s tlačítkem „Jsem tady", které volání potvrdí.

Všechno, co UI zobrazuje, pochází z jednoho místa, `GET /dsh-phononspeak/state`; webový klient 0.2.x
nemá žádnou službu nastavení, takže stav i konfigurace jdou přes HTTP.

## Nastavení

Toto jsou uživatelská nastavení, která host ukládá do `~/.dsh/phononspeak/settings.json` (nebo do
`<dataDir>/settings.json`, když je nastavená volba `dataDir` v Cordis). Samotný `Config` v Cordis je
jen infrastruktura: `dataDir`, `pythonPath`, `autoProvision`.

| Pole | Výchozí | Význam |
|---|---|---|
| `enabled` | `true` | Hlavní vypínač. Když je vypnutý, akce mluvení se odmítnou, sekce promptu je prázdná a automatická volání k počítači přestanou. `stop`, `status`, `voices`, `install` a `ack` fungují dál. |
| `engine` | `auto` | `auto`, nebo jeden z `supertonic`, `piper`, `pocket`, `say`. |
| `voice` | `M1` | Id hlasu z `action=voices`. Supertonic nabízí F1–F5 a M1–M5. |
| `language` | `cs` | `cs` nebo `en`. |
| `speed` | `1.0` | Rychlost řeči, `0,7`–`1,6`. Host hodnotu ořezává. |
| `volume` | `1.0` | `0`–`1`, předává se do `afplay -v` při systémovém přehrávání. |
| `autoSummary` | `false` | Číst shrnutí po každé odpovědi. Zapne i odpovídající instrukci v promptu. |
| `maxChars` | `300` | Tvrdý limit znaků k přečtení; delší text se zkrátí na hranici věty a oznámí se jako zkrácený. Stránka nabízí `100`–`1200`; host všechno, co dostane, ořeže na `40`–`1200`. |
| `attentionRepeatSec` | `0` | Opakovat větu volání každých N sekund do potvrzení. Stránka nabízí 0 / 15 / 30 / 60; host přijímá 0–600 a `0` znamená jednou. |
| `notify` | `true` | Notifikace v macOS u volání k počítači. |
| `systemPlayback` | `true` | Přehrát přes `afplay`, když nemůže hrát žádná viditelná karta prohlížeče. Když je vypnuto, výstup jde vždy do stránky. |
| `dndFrom` / `dndTo` | `""` | Okno klidu v místním čase, `HH:MM`–`HH:MM`. Prázdná hodnota znamená vypnuto. Okno může přecházet přes půlnoc (`22:00`–`07:00`). |
| `commercialMode` | `true` | Drží nekomerční enginy mimo všechny cesty — automatický řetěz **i** výslovnou volbu — a označí je na kartách enginů. S výchozím `on` je `say` odmítnutý, dokud nezapneš i následující pole. |
| `allowPersonalVoice` | `false` | Výslovný opt-in pro `say` z macOS, který Apple licencuje jen pro osobní nekomerční výstup. |
| `voices` | `[]` | Pojmenované klonované hlasy: `{id, name, engine, path, createdAt, rightsConfirmed}`. |

Karty enginů na stejné stránce ukazují u každého enginu, jestli je dostupný a proč ne, jeho licenci,
velikost a tlačítko **Instalovat** / **Opravit**, které spustí přípravu a zobrazí průběh. Klonovaný
hlas se přidává jménem a absolutní cestou k wav souboru a formulář se neodešle bez zaškrtávacího pole
„Mám právo tento hlas použít".

## Enginy a licence

Licence je tu vlastnost, ne poznámka pod čarou: engine, jehož licence se do kontextu nehodí, zůstává
mimo automatickou volbu a jeho licence je vidět v UI, ne zahrabaná. `auto` prochází
**supertonic → piper → pocket → say**.

| Engine | Čeština | Klonování | Licence | Velikost / provoz | Naměřeno na vývojovém Macu |
|---|---|---|---|---|---|
| **Supertonic 3** (výchozí) | ano, 31 jazyků včetně `cs` | ne | kód MIT, váhy OpenRAIL-M (komerční užití ano; přiložit licenci a její use restrictions, označit upravené soubory) | 380 MB model, ~160 MB venv (ONNX) | 7,39 s českého zvuku za 1,65 s výpočtu v ustáleném stavu; studené volání je pomalejší — 3,4 s zvuku za 2,2 s včetně načtení modelu; 44,1 kHz; 10 hlasových stylů F1–F5/M1–M5 |
| **Piper** | ano, jirka / kasandra | ne (dotrénování možné) | engine GPL-3.0-or-later, volaný jako samostatný proces, nikdy nebundleovaný ani nestahovaný; hlasy CC0 / CC-BY-4.0 | 60–80 MB na hlas, bez venv, binárku si dodáš sám | kolem 17× realtime; komolí výslovnost („Vltava" → „Voltava", „Kč" → „káčej") |
| **Pocket TTS Czech** | ano, a jediná cesta ke klonování | ano, z wav | CC-BY-4.0, atribuce ÚFAL / ParCzech | 438 MB model + ~1 GB Python/torch | na CPU rychlejší než realtime; trénováno na 976 h parlamentních projevů, tedy formální dospělý registr |
| **macOS `say`** | ano, Zuzana | ne | Apple macOS SLA §2.F: jen osobní, nekomerční užití; v komerčním režimu odmítnutý i při výslovné volbě, dokud nezapneš `allowPersonalVoice` | 0 MB | okamžité; robotické; nejlepší česká normalizace textu z těch čtyř |

Piper je schválně „přines si vlastní binárku": jeho licence je GPL-3.0-or-later, takže ho plugin ani
nestahuje, ani nebalí — jen spustí `piper`, který najde v `PATH`, nebo cestu z `PHONONSPEAK_PIPER`.
Hlasy jsou obyčejné dvojice `.onnx` + `.onnx.json`; plugin je hledá v `PHONONSPEAK_PIPER_VOICES`,
`$HARNESS_AI/models/piper` a `~/.local/share/piper`.

`say` je odmítnutý, dokud je `commercialMode` zapnutý a `allowPersonalVoice` vypnutý: `auto` ho
přeskočí a výslovné `engine=say` z tool callu nebo z nastavení vrátí odmítnutí místo zvuku. Když
nezbyde jiný použitelný engine, úloha skončí chybou s vysvětlením — místo aby na něj potichu spadla.
Odmítnutí je hodnota, ne pád — tool ho vrátí a fronta ho zaznamená. Zapnutí `allowPersonalVoice` je
tvrzení, že výstup je osobní a nekomerční, ne pohodlný přepínač.

Vědomě vyloučené, protože jejich licence nejsou komerční: XTTS v2, ZipVoice-CZ, OmniVoice, Higgs, Fish
s2-pro a MMS. Nejostřejší případ je XTTS v2 — CPML zakazuje komerční užití modelu *i jeho výstupů* a
Coqui, firma, která by mohla komerční licenci prodat, už neexistuje.

Podrobnosti, atribuční řádky k převzetí a povinnosti OpenRAIL-M: [docs/VOICES.md](docs/VOICES.md).

## Klonování hlasu a souhlas

Pocket TTS Czech klonuje hlas z krátké wav nahrávky. Je to jediný engine, který tu klonuje, a plugin ho
bere jako opt-in funkci s krokem souhlasu, protože licence nepokrývá to, co lidé obvykle „hlasem" myslí.

**Co licence pokrývá.** CC-BY-4.0 pokrývá model a jeho trénovací data (ParCzech, 976 hodin parlamentních
projevů). **Nedává** ti právo na hlas konkrétního člověka. Klonuj svůj hlas, nebo hlas, k němuž máš
písemný souhlas.

**Referenční wav soubory jsou reální lidé.** Šest referenčních nahrávek dodávaných s modelem jsou reální
čeští poslanci. Jejich osobnostní práva platí dál, ať licence modelu říká cokoli.

**Co plugin ukládá.** Jen zobrazované jméno, absolutní cestu k tvému wav souboru, id enginu a příznak
potvrzení práv — nikdy kopii zvuku. Když hlas smažeš, soubor zůstane netknutý; plugin ho nikdy
nevlastnil.

**Zaškrtávací pole je povinné.** UI vyžaduje „Mám právo tento hlas použít" a host požadavek bez něj
odmítne (HTTP 400), takže žádný klient ten krok nemůže přeskočit.

**Pocket nemá neutrální náhradní hlas.** Jediné hlasy, které model dodává, je šest referenčních
nahrávek, a ty patří reálným lidem. Namiř Pocket na svůj wav (nebo na klonovaný hlas, který jsi
zaregistroval), místo abys pole hlasu nechal na výchozí hodnotě.

**Co od klonu čekat.** Barva hlasu je předloze znatelně blízko. Prozódie a emoce se nepřenášejí: zní to
jako někdo jiný s podobným hlasem, ne jako ty. Správný vstup je čistá nahrávka řádově od sekund do
desítek sekund.

## Jak to funguje

```
  model ──► nástroj dsh_phononspeak ──► fronta (pozornost > otázka > shrnutí > ruční > test)
                                          │
                                          ▼
                  normalizace → rozdělení na věty (≤220 znaků) → syntéza jednoho wav na větu
                                          │
                        ┌─────────────────┴──────────────────┐
                        ▼                                    ▼
             viditelná karta: <audio> z                 žádná viditelná karta: afplay
             GET /dsh-phononspeak/audio/<id>.wav        + notifikace přes osascript
             (Range, pauza, přeskakování, stop)          (jen macOS)
```

Jeden worker serializuje všechno, takže se dvě úlohy nikdy nepřekryjí. Každá úloha má id, číslo
generace a seznam segmentů; zastavení zvedne generaci, a právě proto běžící syntéza i všechno zařazené
za ní zmizí, místo aby to v tichosti doběhlo.

Celý obrázek — vrstvy, stavový automat úlohy, proč stav cestuje přes HTTP a ne přes službu nastavení,
proč je `say` hlídaný v kódu a jak funguje příprava enginů — je v
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Poctivá omezení

- **Pocket model mluví jako parlament.** Trénovaný byl na 976 hodinách českých parlamentních projevů:
  dospělí, formální registr, hodně mužů. Konverzační čeština, děti a neformální slovosled jsou slabší.
  Dobrá narace, ne herec.
- **Piper komolí česká slova.** Naměřeno na holém enginu: „Vltava" vyjde jako „Voltava" a „Kč" jako
  „káčej". Normalizace peníze přepíše ještě před syntézou, takže „Kč" do enginu dorazí jako „korun";
  místní jména a přejatá slova se nepřepisují, a ta občas ujedou. Piper je nejlevnější engine, ne
  nejlepší.
- **Supertonic nemá streamovací API.** Streamujeme po větách: první věta se syntetizuje a hraje, zatímco
  se vyrábí další. První zvuk tím přijde brzy, ale není to stream po vzorcích.
- **macOS-first.** Linux a Windows nemají `say`, `afplay` ani `osascript`. Enginy fungují dál, ale zvuk
  jde ze stránky a notifikace i opakování do potvrzení jsou vlastnosti macOS. Když na ne-macOS hostu
  není vidět žádná karta, systémové přehrávání nemá co přehrát.
- **Pocket stojí kolem 1 GB** Pythonu a torchu ještě před 438 MB modelu. Když je to moc, zvol Supertonic
  nebo Piper.
- **Plugin říká to, co dostane.** Text normalizuje a zkracuje, ale nepozná, jestli je shrnutí od modelu
  dobré. Vágní shrnutí přečte stejně sebevědomě jako přesné.
- **Rychlost závisí na enginu.** Host každou hodnotu ořeže na 0,7–1,6; `say` ji převádí na slova za
  minutu, Piper se vrátí k výchozí rychlosti, když jeho CLI přepínač odmítne, a Pocket TTS Czech žádné
  ovládání rychlosti nemá, takže posuvník na tomhle enginu nic nedělá.
- **Po odstavcích, ne po konverzaci.** V 0.1.0 není historie přečteného, tlačítko „přečti tuhle zprávu"
  u každé zprávy, klávesová zkratka ani slash příkaz.
- **Fronta je omezená.** Nejvýš 24 čekajících úloh: nad tím se zahodí nejstarší čekající a jedna úloha
  je omezená na 20 000 znaků před normalizací.

## Řešení potíží

Žádný zvuk, engine, který se nechce nainstalovat, fronta, která vypadá zaseknutá, oprávnění k
notifikacím a jak se podívat na živý stav přes `curl`:
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

Jeden příkaz, který stojí za zapamatování:

```
curl -s http://127.0.0.1:<port>/dsh-phononspeak/state | python3 -m json.tool
```

## Soukromí

Text, který slyšíš, neopustí stroj: syntéza je lokální a žádná telemetrie neexistuje. Jediná metadata,
která plugin drží — engine, trvání, chyba — jsou v paměti a jdou do lokální stránky; mluvený text se
nikdy nezapíše do logu. Co se ukládá, kam a jak to všechno smazat:
[docs/PRIVACY.md](docs/PRIVACY.md).

## Vývoj

```
lib/index.js      Hostitelská polovina: Config, nastavení, fronta, HTTP routy, nástroj, prompt, eventy, příprava enginů
lib/contract.js   Tabulka rout, výchozí hodnoty, priority, limity, tvar stavu — jediný zdroj názvů
lib/engines.js    Adaptéry enginů (supertonic, piper, pocket, say), detekce a syntéza
lib/normalize.js  Normalizace textu a dělení na věty
lib/provision.js  Datové cesty, hledání a ověření Pythonu, tvorba venv se značkami, stahování modelu
lib/client.js     Webová polovina: stránka nastavení, mini přehrávač, karta nástroje, banner volání
cordis.patch.yml  Patch bundlu: jeden řádek hostitele, id `phononspeak`
scripts/verify.mjs     Brána před vydáním: manifest, patch, syntaxe, klient vs kontrakt, locale, testy, odkazy
scripts/make-index.mjs Zapíše index.json trhu pluginů z git HEAD a package.json
```

Žádný build neexistuje: `lib/*.js` se dodává tak, jak je (ESM, čisté pro `node --check`). Webová
polovina je samostatný modul pro prohlížeč bez bundleru, takže opakuje literály rout z
`lib/contract.js`; `lib/contract.js` dokumentuje záměr, že kontraktní test drží obě strany v souladu.
Žádný CI workflow zatím není publikovaný, a proto na této stránce není žádný CI badge.

Užitečné kontroly při práci:

```
node scripts/verify.mjs          # brána před vydáním: manifest, patch, syntaxe, klient vs kontrakt,
                                 # locale, ikona, testy a každý relativní odkaz v obou README
node scripts/make-index.mjs      # zapíše index.json trhu pro aktuální commit a verzi
node --check lib/index.js && node --check lib/contract.js
curl -s http://127.0.0.1:<port>/dsh-phononspeak/state | python3 -m json.tool
dsh_phononspeak action=status
```

Viz také [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) kvůli HTTP rozhraní a kontraktu fronty.

## Licence

Plugin samotný je MIT — viz [LICENSE](LICENSE). Enginy, které může volat, MIT nejsou a jejich licence
cestují s nimi: [docs/VOICES.md](docs/VOICES.md) vypisuje každou z nich a co smíš šířit.

## Atribuce

- **Supertonic 3** — model a váhy od Supertone. Kód MIT, váhy pod OpenRAIL-M; licence a její use
  restrictions se musí předávat dál a upravené soubory se musí označit.
- **Piper** — engine projektu Rhasspy/Piper, od verze 1.3 GPL-3.0-or-later (do 1.2.0 MIT), vydávaný jako
  fork `piper1-gpl`; volá se jako samostatný proces a tento plugin ho ani nedistribuuje, ani nestahuje.
  České hlasy jsou podle hlasu CC0 nebo CC-BY-4.0.
- **Pocket TTS Czech** — model od `vvolhejn`, CC-BY-4.0, trénovaný na ParCzech4Speech (ÚFAL). Při
  redistribuci modelu nebo jeho výstupu je atribuce ÚFAL a korpusu ParCzech povinná.
- **macOS `say`** — Apple. Jen osobní, nekomerční užití podle licenční smlouvy macOS §2.F. Tento plugin
  to vynucuje, ne uděluje.
