# dsh-phononspeak — projektový brief

> Pracovní dokument (Czech). Veřejná dokumentace pluginu bude anglicky + `README.cs.md`.
> Stav: **návrh po R1** — architektura ověřená proti běžícímu runtime, čeká se na R2–R5.

**Rozhodnuto v R1:** název `dsh-phononspeak` (koncept „phonon" = kvantum zvuku), samostatný plugin vedle
`dsh-agent-voice`/`dsh-voice-studio`, rozsah v0.1 = čtení shrnutí + volání k počítači + nastavení v UI +
mini přehrávač + správa klonovaných hlasů; engine třívrstvý `auto` (pocket → piper → say); klonování opt-in;
přehrávání v aplikaci i v prohlížeči, prioritně desktopová aplikace.

---

## 1. Produktová teze

**Agent, kterého slyšíš, ale neplatíš za každé slovo.**

Plugin dává DeepSeek Harness agentovi *hlasový kanál*, který je:

1. **lokální** — žádná cloudová TTS, žádný API klíč, žádný upload textu,
2. **český-first** — čeština je výchozí jazyk, ne dodatečný,
3. **úsporný** — funguje i na `say` (0 MB) a `piper` (~80 MB); neuronový hlas je opt-in,
4. **ovladatelný z UI** — nastavení, mini přehrávač, správa hlasů,
5. **tichý, dokud nemá co říct** — nikdy nečte uvažování ani mezistavy.

Dvě úlohy:

| Úloha | Co se stane | Proč to má cenu |
|---|---|---|
| **Čtení shrnutí odpovědi** | Model připraví 1–3 věty shrnutí, plugin je přečte | Můžeš pracovat rukama a poslouchat výsledek |
| **Zavolání k počítači** | Agent potřebuje rozhodnutí / schválení → krátká věta + notifikace + UI výzva | Nemusíš sledovat obrazovku, ale nic nezmeškáš |

---

## 2. Co už na stroji existuje — a v jakém stavu to skutečně je

Ověřeno čtením zdrojáků a runtime katalogu (`@deepseek-ai/dsh-tools` a `dsh-settings` **0.2.1-rc.3**):

| Projekt | Stav | Co to znamená pro nás |
|---|---|---|
| `dsh-agent-voice` 0.1.7 | **nefunguje na 0.2.1-rc.3** — importuje `settingsNamespace`/`installSettingsSection`, které z `dsh-settings` zmizely; peer range `^0.1.0-rc.6` nesplňuje 0.2.1-rc.3, takže ho loader tiše přeskočí | **Nekopírovat jeho scaffolding.** Jeho HTTP route z 0.1.5 (`webServer.register`) je ale přesně to, co chceme |
| `dsh-voice-studio` 0.2.0 | stejná smrt (stejný settings scaffolding, stejné peery) | „Modul na klonování" v něm dnes neběží; klonování reálně poskytuje `dsh-video` přes pocket |
| `dsh-video` 0.4.0 | **jediný nainstalovaný** (`file:` link v profilu `desktop`) | Zdroj pravdy pro: `Config` + generický settings formulář, licence-carrying TTS backendy, `webServer` audio route, `scripts/*-selftest.mjs` |
| `dsh_speech` (DSP hlasy) | funguje (součást `dsh-video`) | Recepty modulace `say`, ne klonování |

**Důsledek:** „modul pro kopírování hlasu", který v Harnessu reálně existuje, je `dsh_studio`/`dsh_video`
(pocket-tts-czech, `--voice <wav>`). Nový plugin tedy nestavíme na `voice-studio`, ale na **pocket modelu
přímo** a na aktuálních API.

---

## 3. Ověřená architektura (proti 0.2.1-rc.3)

```
┌─────────────────────────── Host (Cordis plugin, Node) ───────────────────────────┐
│  export Config (schemastery)  → generický formulář v Settings (bez vlastního UI)  │
│  apply(ctx, config)                                                              │
│  ctx.tools        dsh_phononspeak (speak | summary | attention | stop | status)  │
│  ctx.webServer    GET /dsh-phononspeak/audio/<id>.wav   (prefix route, validace) │
│                   GET /dsh-phononspeak/state            (fronta pro UI, JSON)   │
│  ctx.systemPrompt sekce „mluv krátce, nikdy nečti uvažování"                     │
│  ctx.skills       registerProvider → SKILL.md (skills/ se jinak neobjeví!)       │
│                                                                                   │
│   Queue (priorita: attention > otázka > shrnutí > ruční)                          │
│     job → normalize(text) → engine.synth() → cache → play                        │
│                                                                                   │
│   Engine chain: say (0 MB) → piper (~80 MB, MIT) → pocket (418 MB, CC-BY-4.0)     │
└───────────────────────────────────────────────────────────────────────────────────┘
                                   ▲                    ▲
                      HTTP audio + /state              │ afplay / osascript
                                   │                    │ (desktop app, out-of-tab)
┌────────────────────────── Client (web UI plugin) ────────────────────────────────┐
│  dsh.client → window.__ModuleLoader__.load({id:"dsh-phononspeak", …})             │
│  shell.overlay  id „phononspeak-player"  — play/pause/stop, fronta, „mluví teď"   │
│  conversation.view id „phononspeak-voices" — správa klonovaných hlasů            │
│  banner „Agent tě volá" + „Jsem tady"                                             │
│  (settingsScope je v 0.2.1-rc.3 nedostupný → stav jde přes /state, ne přes settings)│
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Rozhodovací body ověřené v kódu:**

- `ctx.webServer.register({kind:'prefix', path, handler})` existuje a vrací disposer; duplicitní `(kind,path)` hází. `getOrigin()` dává absolutní URL.
- `ctx.settings` je `SettingsForms` — **není** zde `register()` ani `watch()`. Stav pro UI tedy musí jít přes HTTP route (nebo Typert `@Remote`). Base64 přes settings dokument, jak to dělá `agent-voice`, už není možný.
- Tool DSL **neumí `enum`** — povolené hodnoty se vypisují v popisu (dsh-video to dokumentuje a takto to dělá).
- `.volatile()` config pole přicházejí jako `{get()}` buňky → `readConfigValue()`/`resolveConfig()`.
- Události, které použijeme (agent-voice je nepoužívá, takže se nebudeme bít): `agent/turn-stopping` (serial, `{agent,turn,signal}`), `subagent/end` s `lastAssistantMessage: ContentBlock[]` (filtr `type === "text"`), `approval/request` (waterfall — vždy `return next()`), `user-questions/request` (waterfall).
- `StreamChunk.type` rozlišuje `text-delta` vs `reasoning-delta` — jediný skutečný filtr uvažování; zbytek je prompt.
- Porty 7862/7863 jsou obsazené starými pluginy; pocket worker poběží na **7864+** s health-checkem proti cizímu procesu.

**Proč HTTP route:** WAV po HTTP znamená `Range`, pauzu, seek a streamování po větách; žádné megabajty base64 v dokumentu nastavení. UI dostane URL.

**Proč fronta:** dvě oznámení v jedné sekundě se u `afplay` překryjí. Fronta s prioritou a `stop` je hlavní UX rozdíl proti existujícím pluginům.

---

## 4. Volba enginu — fakta z tohoto stroje

| Engine | cs | Klonování | Licence | Instalace | Provoz | Kvalita |
|---|---|---|---|---|---|---|
| macOS `say` (Zuzana / Premium) | ✔ | ✖ | součást macOS, výstup volně použitelný | 0 MB | ~0 | 3/10 — srozumitelné, robotické |
| **Piper** (jirka/kasandra medium, na disku) | ✔ | ✖ (lze dotrénovat, MIT pipeline) | **MIT** | ~80 MB | ~50 MB RAM, >10× realtime | 6/10 — příjemné, místy ploché |
| **pocket-tts-czech** (`vvolhejn`, na disku 418 MB) | ✔ | **✔ z wav** | **CC-BY-4.0** (atribuce ÚFAL) | + ~1 GB Python/torch env (už existuje v `HarnessAI/envs/chatterbox-3.11`, pocket_tts 3.3.0) | ~1–2 GB RAM, >1× realtime CPU (6 vrstev) | 7,5/10 narace; slabší konverzace |
| XTTS v2 (Coqui) | ✔ | ✔ (nejlepší) | **CPML — nekomerční** | ~2 GB | — | vyloučeno licencí |
| Chatterbox (Resemble) | ✖ (jen EN) | ✔ | MIT | ~2 GB | — | pro cs nepoužitelné |
| Qwen3-TTS | ✖ | — | — | velké | — | čeština mezi jazyky není |

Model: 6vrstvý distill z 24vrstvého učitele, 976 h parlamentních projevů (ParCzech4Speech), 524 řečníků,
sentencepiece vocab 3999, doporučená teplota 0.3, výstup 24 kHz mono.

**Tiering (R1):** `auto` = pocket → piper → say; `eco` = say → piper (bez Pythonu); `quality` = pocket.

---

## 5. Odpověď na otázku: jak je to vhodné na klonování a jak realisticky to zní

**Krátce:** pro *češtinu, lokálně a s komerčními právy* je dnes jediná použitelná cesta
`pocket-tts-czech` (CC-BY-4.0). XTTS v2 klonuje lépe, ale licence CPML komerční použití zakazuje — to je
tvrdé omezení, ne šedá zóna.

**Co od klonování čekat:**
- **Barva hlasu:** poznatelně blízká předloze — nejsilnější stránka.
- **Prozódie a emoce:** nepřenáší se. Výsledek zní jako *někdo jiný s podobným hlasem*, ne jako ty.
- **Vstup:** krátká čistá nahrávka (řádově sekundy až desítky sekund); přesný požadavek ověřím v dokumentaci modelu.
- **Realismus celkově:** dobrá neuronová narace, ne ElevenLabs. Na shrnutí a oznámení výrazně nad `say` i Piperem; na emocionální dialog to nestačí.
- **Slabiny, které uslyšíš:** trénink = formální parlamentní projev (dospělí, hodně mužů); konverzační čeština, děti a neformální slovosled horší; tokenizer citlivý na velká písmena a interpunkci; čísla, zkratky, URL a anglické termíny je nutné normalizovat před syntézou.

**Doporučení:** klonování ano, ale opt-in, s atribucí v UI i v README; výchozí hlas pro každodenní čtení =
vestavěný hlas (6 českých z ParCzech nebo Piper), ne klon.

---

## 6. Distribuce — ověřená pravidla (formát indexu 1)

- **Repo:** `github.com/meliodascz89/dsh-phononspeak`, MIT, veřejné po schválení.
- **Instalace při vývoji:** `plugin_manager install_bundle` s `target: "/Volumes/KvaDisk/Projekty/dsh-phononspeak"` (absolutní cesta).
- **Instalace z repa:** `git+https://github.com/meliodascz89/dsh-phononspeak.git#<40-hex SHA>` — market index **neumí** `file:` ani větve; jen `npm` nebo `git` + pin na commit.
- **Market index:** statické `index.json` (format 1, `LocalizedText` musí mít `en`, `title` povinný) na **GitHub Pages** téhož repa; URL musí být finální (redirect je fatální), host ho fetchuje sám (CORS nevadí). Každé vydání = nový commit SHA + `publishTimestamp` v sekundách.
- **Peery:** `>=0.1.1-rc.2 <0.3.0` (jako `dsh-books`) nebo `engines.dsh`; `^0.1.0-rc.6` instalaci odmítne.
- **Bez `prepare`/`install` skriptů** — pnpm u git závislostí spouští build skripty a chce schválení. Shipovat prebuilt `lib/*.js`.
- **`skills/` se automaticky nenačítá** — plugin musí zaregistrovat provider (`ctx.skills.registerProvider`), jinak skill nikdo neuvidí.
- **Dokumentace:** `README.md` (EN) + `README.cs.md` (CS), `docs/ARCHITECTURE.md`, `docs/VOICES.md` (licence), `docs/PRIVACY.md`, `CHANGELOG.md`, `locale/en.json` s `meta.title`/`meta.description`, `icon.svg`.

---

## 7. Rizika a řešení

| Riziko | Dopad | Řešení |
|---|---|---|
| Autoplay policy | ticho po načtení | HTTP audio + přehrávač iniciovaný uživatelem; systémové přehrání jako fallback; silent-WAV unlock při prvním gestu |
| Python + torch (~1 GB) | „úsporný" plugin s těžkou instalací | `eco` režim bez Pythonu; pocket opt-in s explicitním stažením; použít existující env, ne třetí venv |
| Licence CC-BY-4.0 | právní vada | atribuce v README, v UI u hlasu, v metadatech WAV |
| Kolize s `dsh-agent-voice` (stejné eventy, `afplay`) | dvojí oznámení, překryv | agent-voice je dnes mrtvý; přesto detekce a vypínač „vlastník oznámení" |
| TTS komolí čísla/zkratky | nedůvěryhodný hlas | normalizace + testovací korpus (R2/R5) |
| Dlouhá odpověď = dlouhé čtení | otrava | limit znaků, shrnutí, stop |
| Port 7862/7863 obsazen | tichý souboj | 7864+, health-check, nikdy nepředpokládat cizí proces |
| `skills/` neviditelné | dokumentace skillu chybí | `ctx.skills.registerProvider` v host half |

---

## 8. Kritéria hotovosti (návrh)

1. Plugin se nainstaluje přes `install_bundle` a v UI není chyba v konzoli.
2. `dsh_phononspeak action=speak` přehraje zvuk; `action=stop` ho zastaví.
3. Shrnutí odpovědi jde přečíst z tool callu; text jde z `lastAssistantMessage` (jen `type: "text"`).
4. „Volání k počítači" zazní, zobrazí notifikaci a jde potvrdit „Jsem tady".
5. Nastavení přežije restart; DND okno funguje; správa klonovaných hlasů funguje.
6. README (EN+CS) obsahuje instalaci, licenční tabulku, známá omezení a měření.
7. Změřená latence prvního zvuku pro každý engine je v dokumentaci.

---

## 9. Plán práce (agent team)

- **Lead:** architektura, rozhodnutí, integrace, review, publikace.
- **Agent engine:** adaptéry say/piper/pocket, normalizace textu, měření, cache.
- **Agent UI:** klientský plugin — overlay přehrávač, správa hlasů, banner, `/state` polling.
- **Agent docs:** README EN/CS, architektura, licence, changelog, market index.
- **Agent QA:** akceptační testy, latence, kontrola licencí, instalace z gitu.

Rozhodnutí se zapisují do `DECISIONS.md`, postup do `CHANGELOG.md` od 0.1.0.
