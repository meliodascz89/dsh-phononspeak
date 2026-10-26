# Rozhodnutí (decision log)

Formát: ID · datum · rozhodnutí · důvod · dopad. Mění se jen novým záznamem, ne přepisem.

## Kolo R1 — identita a rozsah (2026-10-26)

### D-001 — Název: `dsh-phononspeak`
Uživatel: „chci aby to bylo založeno na modelu phonon". Volba = první možnost (`dsh-phononspeak`),
koncept „phonon" = kvantum zvuku, tedy lehký hlas. Složka, repo i balíček `dsh-phononspeak`.

### D-002 — Samostatný plugin, `dsh-agent-voice` i `dsh-voice-studio` mohou zůstat
Nový plugin je hlasová vrstva (fronta, stop, shrnutí, volání k počítači, UI), ne další TTS studio.
V UI bude detekce konfliktu (dva vlastníci oznámení / dva `afplay`).

### D-003 — Rozsah v0.1
Zahrnuto: čtení shrnutí odpovědi, volání k počítači, nastavení v UI, mini přehrávač, správa klonovaných hlasů.
Nezahrnuto (vědomě): čtení otázek agenta, tlačítko „Přečíst" u každé zprávy, automatické čtení po odpovědi,
klávesová zkratka, slash příkazy, historie přečteného.

### D-004 — Engine: třívrstvý `auto` (pocket → piper → say)
Nejlepší česká narace a klonování, ale s postupným fallbackem, aby plugin fungoval i bez Pythonu.

### D-005 — Klonování: ano, opt-in přes pocket model
`pocket-tts-czech` (CC-BY-4.0) klonuje z wav; atribuce v UI i v README. Výchozí hlas je vestavěný, ne klon.
XTTS v2 zůstává mimo (CPML = nekomerční).

### D-006 — Přehrávání: aplikace i prohlížeč, prioritně desktopová aplikace
Uživatel: „možnost 1, ale je to hlavně pro aplikaci a ne tu webovou obdobu dsh".
Prakticky: systémové přehrání (`afplay`) + notifikace (`osascript`) jako hlavní kanál v desktopu,
HTTP audio route + `<audio>` v UI jako ovládaný kanál (pauza, stop, fronta).

---

## Zjištění z auditu, která mění implementaci (2026-10-26)

### D-007 — Nekopírovat scaffolding `dsh-agent-voice` ani `dsh-voice-studio`
Na runtime 0.2.1-rc.3 neexistují `settingsNamespace`/`installSettingsSection` a `ctx.settings` neumí
`register()`/`watch()`; oba pluginy navíc mají peer range, který loader tiše přeskočí. Oba jsou dnes mrtvé.
Zdroj pravdy pro host half = `dsh-video` (`Config` + `readConfigValue`/`resolveConfig`, licence-carrying
TTS backendy, `webServer` audio route, selftesty).

### D-008 — Stav pro UI přes HTTP route, ne přes settings dokument
`/dsh-phononspeak/state` (JSON: fronta, aktuální job, hlasitost, chyba) + `/dsh-phononspeak/audio/<id>.wav`.
Base64 přes settings je po zrušení namespace API nedostupné. `webServer.register({kind:'prefix'})` je ověřené.

### D-009 — Události, které `dsh-agent-voice` nepoužívá
`agent/turn-stopping` (serial) a `subagent/end` s `lastAssistantMessage` (`ContentBlock[]`, filtr `type === "text"`)
pro shrnutí; `approval/request` a `user-questions/request` pro volání k počítači (waterfall, vždy `return next()`).
Uvažování se filtruje `StreamChunk.type === "text-delta"` vs `"reasoning-delta"`; zbytek je prompt.

### D-010 — Distribuce: git pin na commit + market index na GitHub Pages
Index formátu 1 neumí `file:` ani větve; `source: {type:"git", url, commit: <40-hex>}`. Každé vydání =
nový SHA, nová `version`, nový `publishTimestamp`. Peery `>=0.1.1-rc.2 <0.3.0` nebo `engines.dsh`.
Bez `prepare`/`install` skriptů (pnpm by chtěl schválení build skriptů). `skills/` se nenačítá samo →
`ctx.skills.registerProvider` z host half.

---

## Zjištění z rešerše enginů (2026-10-26)

### D-011 — `say` je právně jen pro osobní, nekomerční použití
Licence macOS (SLA §2.F „Voices; Live Captions") dovoluje systémové hlasy použít pouze pro vlastní
originální obsah „for your personal, non-commercial use"; jakékoli jiné užití včetně zveřejnění
nebo komerčního kontextu je zakázáno. `say` tedy nesmí být výchozí komerční cesta — jen osobní náhled
s varováním a vypínačem. Stejné omezení platí pro Personal Voice.

### D-012 — Supertonic 3 je nejlepší komerčně čistá česká narace, ale neklonuje
Supertone `supertonic-3`: 99M param., ONNX, 31 jazyků včetně `cs`, kód MIT, váhy OpenRAIL-M (komerčně
ano, s povinností přiložit licenci a use-restrictions a označit upravené soubory). Měřeno na tomto stroji:
380 MB model, RSS ~623 MB, RTF 0,19, 44,1 kHz, 10 hlasových stylů F1–F5/M1–M5, bez streamovacího API,
**bez open zero-shot klonování** (klon jen v placeném Voice Builderu). Slabina: neexpanduje české zkratky
(„Kč" → „Kač").

### D-013 — Piper je nejúspornější, ale česky špatně vyslovuje a engine je GPL
Piper: 3 české hlasy (jirka low/medium, kasandra medium), 60 MB, RSS ~267 MB, RTF 0,056 (17× realtime),
streaming `--output-raw`. Engine `piper-tts` ≥1.3 je **GPL-3.0-or-later** (MIT jen do 1.2.0) → volat jako
samostatný proces, binárku nedistribuovat v MIT repu. Měření: „Vltava" → „Voltava", „Kč" → „káčej".

### D-014 — Pocket TTS Czech zůstává jediná cesta ke klonování
`vvolhejn/pocket-tts-czech`, CC-BY-4.0, 438 MB, 6 vrstev, klon z libovolného wav, CPU faster-than-realtime.
Trénink pouze na parlamentních projevech (976 h ParCzech) → formální dospělý registr, slabší konverzace.
Vzorky hlasů v `voices/` jsou reální čeští poslanci — CC-BY kryje nahrávku, ne osobnostní práva;
klonovat jen vlastní hlas nebo s písemným souhlasem. XTTS v2, ZipVoice-CZ, OmniVoice, Higgs, Fish s2-pro,
MMS jsou nekomerční → mimo rozsah.

### D-015 — UI sloty ověřené živě (0.2.1-rc.3)
K dispozici: `settings.section` (vlastní stránka v nastavení), `shell.overlay` (plovoucí přehrávač),
`conversation.composer.dock` a `conversation.input.left/right` (rychlá ovládání u composeru),
`conversation.chat.assistant-actions` (akce u dokončené odpovědi), `tool.call.toolview` (keyed podle jména
nástroje — vlastní karta pro `dsh_phononspeak`), `conversation.chat.turnTail`, `settings.general.item`,
`conversation.view`, `plugins.bundle.config`. **Client nemá `settings` službu** → stav i zápis konfigurace
půjdou přes HTTP routes hostu (`/dsh-phononspeak/state`, `/config`), host je aplikuje přes `configEditor`.

---

## Zjištění z prvního živého nasazení (2026-10-26 13:00)

### D-016 — Pád aplikace: `connection.rpc.intercept` je obsazený
První nainstalovaná verze volala `connection.rpc.intercept('/api', …)`. Kanál `/api` má ale jediného
interceptora — Typert Gateway — a druhá registrace hází
`connection: shared RPC channel "/api" already has an intercepto r`. Odmítnutý promise v asynchronním
inicializátoru se stal unhandled rejection, což 0.2.x vyhodnotí jako **fatal load failure** a restartuje
celou desktopovou aplikaci. Řešení: vlastní Typert Remote namespace `phononspeak/*` (stejný mechanismus
jako `dsh-rea`), každá metoda obalená do `{ok:false,error}` a `.catch()` na inicializaci i na frontě.

### D-017 — Desktop renderer neposílá `fetch` na HTTP routes
Renderer běží na schématu `dsh-app://`; relativní `fetch('/dsh-phononspeak/state')` se k HTTP route
Hostu vůbec nedostane (dokumentace `dsh-host-webserver`: „Electron loads dist over file:// and carries
fetch over an IPC bridge"). HTTP prefix route zůstává jen pro `dsh web` a curl; UI používá Connection RPC.

### D-018 — Licence `say` je odmítnutí, ne varování
`pickEngine(forced)` dřív výslovně zvolený `engine=say` propustil. Teď je odmítnutý i explicitně
(`refused: "licence"`), protože varování není licence. Dokumentace přepsána na „refusal, not a warning".

### D-019 — Pocket nikdy nebere hlas sám
`pickVoice` vracel `voices[0]`, což je u pocketu reference reálného poslance. Teď pocket dostane hlas jen
z registrovaných klonů; `auto` ho bez klonu přeskočí a explicitní požadavek vrátí chybu.

### D-020 — Audio cache má skutečný rozpočet
`LIMITS.audioCacheBytes` (200 MB) se dřív nečetl; prune bylo podle počtu a jen v rámci běhu. Teď se
prune řídí bajty a při startu se uklidí i soubory z předchozích běhů.

### D-022 — Ověřený end-to-end řetěz (po opravě)
`dsh_phononspeak action=summary` → supertonic syntéza (44,1 kHz WAV v `~/.dsh/phononspeak/audio`) →
RPC `phononspeak/audio` → přehrávač v UI → `finished` → `current` se vyčistí. `action=attention`
zobrazí notifikaci, banner a opakuje přes `afplay` podle `attentionRepeatSec`. `doctor` hlásí
`rpcRegistered: true`; `engine=say` je odmítnutý; `presence` z prohlížeče přepíná `output` na `browser`.
