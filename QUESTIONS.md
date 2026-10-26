# dsh-phononspeak — otázky k rozhodnutí

> Odpovídá se po kolech (R1…R5). Každá otázka má klikatelné možnosti v chatu;
> tento soubor je jejich úplná mapa, aby nic nezapadlo. Doporučená možnost je označená **★**.
> Odpovědi se doplňují do sloupce „Odpověď".

---

## R1 — Identita a rozsah

### Q1.1 Jak se plugin jmenuje?
Složka je `dsh-phononspeak`, v zadání je `dsh-pononspeak` (překlep?).
- **★ `dsh-phononspeak`** — odpovídá složce i konceptu („phonon" = kvantum zvuku; lehký hlas)
- `dsh-pononspeak` — přesně jak bylo napsáno; znamenalo by přejmenovat i složku a repo
- jiné jméno (napíšu)

**Odpověď:**

### Q1.2 Jaký má být vztah k `dsh-agent-voice` a `dsh-voice-studio`?
- **★ Nový samostatný plugin; oba mohou zůstat nainstalované** (detekce konfliktu + varování v UI)
- Nahrazuje `dsh-agent-voice` (ten se odinstaluje; `voice-studio` zůstává na dávkové klonování)
- Staví na `dsh-voice-studio` jako backendu (nový plugin = jen UI + fronta nad ním)
- Nahrazuje oba (jeden plugin na všechno)

**Odpověď:**

### Q1.3 Co všechno má být v první verzi (v0.1)? *(vyber vše, co chceš)*
- **★ Čtení shrnutí odpovědi** (model dodá text, plugin přečte)
- **★ Volání k počítači** (agent potřebuje rozhodnutí → hlas + notifikace)
- **★ Nastavení v UI** (hlas, rychlost, hlasitost, auto-režim)
- **★ Mini přehrávač** (play/pause/stop, „mluví teď", fronta)
- Přečíst otázku, kterou se agent ptá (`ask_user_question` nahlas)
- Tlačítko „Přečíst" u každé odpovědi v chatu
- Automatické čtení shrnutí po každé odpovědi
- Klávesová zkratka (např. ⌥⌘S) pro přečtení poslední odpovědi
- Slash příkazy (`/speak`, `/mute`, `/voice`)
- Správa klonovaných hlasů v UI (nahrát vzorek, pojmenovat, smazat)
- Historie přečteného (co agent řekl, kdy)

**Odpověď:**

### Q1.4 Jaký engine a výchozí režim?
- **★ Třívrstvý `auto`: pocket → piper → say** (nejlepší kvalita, ale první běh stahuje model)
- **★ `eco` jako výchozí: say → piper** (nula instalace, okamžité, robotičtější)
- Jen `say` (nejúspornější, nejméně přirozené)
- Jen `piper` (MIT, ~80 MB, bez klonování)
- Jen `pocket` (nejlepší čeština + klonování, ~1 GB Python/torch)
- Jiné (napíšu)

**Odpověď:**

### Q1.5 Patří klonování hlasu do tohoto pluginu?
- **★ Ano, ale opt-in: pocket klonuje z wav, s atribucí CC-BY-4.0 v UI** (výchozí hlas = vestavěný)
- Až v v0.2 — v0.1 jen vestavěné hlasy (pocket 6 českých + Piper + say)
- Ne — klonování zůstane jen ve `dsh-voice-studio` (čisté oddělení)
- Ano včetně XTTS jako „nekomerční" volby s varováním
- Jiné (napíšu)

**Odpověď:**

### Q1.6 Kde se má přehrávat zvuk?
- **★ Obojí: prohlížeč (s ovládáním) + systémové přehrání jako fallback, když je tab na pozadí**
- Jen v prohlížeči (pauza, seek, UI; ale autoplay policy řeší první klik)
- Jen systémově (`afplay`; funguje vždy, ale bez UI ovládání a bez pauzy)
- Jiné (napíšu)

**Odpověď:**

---

## R2 — Chování hlasu

### Q2.1 Co přesně se má číst? *(vyber vše)*
- **★ Shrnutí odpovědi** (1–3 věty, které připraví model)
- **★ Výzva k pozornosti** („Potřebuji od tebe rozhodnutí")
- Otázka z `ask_user_question` (přečíst znění i možnosti)
- Oznámení „hotovo" u dlouhých úloh
- Upozornění na chybu / selhání nástroje
- Celá odpověď (ne jen shrnutí) — na vyžádání
- Jiné (napíšu)

**Odpověď:**

### Q2.2 Kdo a kdy čtení spouští? *(vyber vše)*
- **★ Model přes tool call** (`dsh_phononspeak action=summary text=…`)
- **★ Uživatel z UI** (tlačítko u zprávy / v přehrávači)
- Klávesová zkratka
- Slash příkaz v chatu
- Automaticky po každé odpovědi (bez tool callu, klient si vezme poslední text)
- Jiné (napíšu)

**Odpověď:**

### Q2.3 Má se čtení shrnutí dít automaticky po každé odpovědi?
- **★ Ne — jen na vyžádání** (model nebo uživatel); auto-režim jde zapnout v nastavení
- Ano, vždy (dokud nezapnu „mute")
- Ano, ale jen u odpovědí delších než X znaků
- Jen když odejdu od počítače (jak to poznat? → vypínač „jsem pryč")
- Jiné (napíšu)

**Odpověď:**

### Q2.4 Jak dlouhé má být shrnutí a jak se hlídá?
- **★ 1–3 věty, max ~300 znaků; plugin delší text zkrátí a řekne „shrnuto"**
- Bez limitu — model rozhodne
- Pevně: 1 věta (max 140 znaků)
- Dvě úrovně: krátké (1 věta) / delší (do 30 s)
- Jiné (napíšu)

**Odpověď:**

### Q2.5 Jak normalizovat text před syntézou? *(vyber vše, co má plugin dělat)*
- **★ Čísla, data, jednotky, měny** → slovy česky („2026" → „dva tisíce dvacet šest")
- **★ Zkratky a akronymy** → hláskovat nebo rozepsat („API" → „á pé í")
- **★ Odkazy a URL** → „odkaz" + doména, nebo přeskočit
- **★ Kód a příkazy** → přeskočit, jen oznámit „blok kódu"
- **★ Markdown** (odrážky, nadpisy, tabulky) → čistá próza
- Anglické termíny → fonetický přepis pro český hlas
- Emoji a symboly → přeskočit
- Nic z toho — číst doslova (nejjednodušší, ale komolí)

**Odpověď:**

### Q2.6 Jak se chová fronta a přerušení?
- **★ Priorita: attention > otázka > shrnutí > ruční; nové oznámení nepřeruší rozehrané, jen se zařadí**
- Vždy přerušit a mluvit nové (stop + start)
- Fronta FIFO, bez priorit
- Sloučit: pokud přijdou dvě zprávy do 2 s, přečíst jen druhou
- Jiné (napíšu)

**Odpověď:**

### Q2.7 Jak vypadá „volání k počítači"? *(vyber vše)*
- **★ Krátká věta nahlas** („Potřebuji od tebe rozhodnutí")
- **★ macOS notifikace** (i když je prohlížeč na pozadí)
- **★ Banner v UI s tlačítkem „Jsem tady"** (zastaví další opakování)
- Opakovat větu každých N sekund, dokud nepřijdu
- Zvukový signál (tón) před větou
- Zesílit / změnit hlas pro naléhavost
- Zapsat do historie, kdy mě agent volal
- Jiné (napíšu)

**Odpověď:**

---

## R3 — Technika a provoz

### Q3.1 Jak řešit runtime závislosti?
- **★ Použít existující prostředí na disku** (`/Volumes/KvaDisk/HarnessAI/envs/chatterbox-3.11`, pocket_tts 3.3.0 už je) + fallback: vlastní venv v `~/.dsh/phononspeak-venv`
- Vždy vlastní venv (izolace, ale ~1 GB a delší první běh)
- Žádný Python: jen `say` + `piper` binárka (opravdu úsporné)
- Bundleovat Pocket TTS jako binárku (velké, ale bez Pythonu) — nutno ověřit, zda existuje
- Jiné (napíšu)

**Odpověď:**

### Q3.2 Jaké platformy?
- **★ macOS-first** (say/afplay/osascript), ostatní platformy fungují jen s Piperem
- macOS + Linux (bez `say`)
- Všechny tři (Windows: SAPI)
- Jen macOS

**Odpověď:**

### Q3.3 Streamování
- **★ Po větách**: syntetizuj první větu hned, přehrávej, mezitím další (rychlý první zvuk)
- Celý text najednou (jednodušší, pozdější první zvuk)
- Skutečný stream z pocket serveru (`pocket_tts serve`) — nejrychlejší, ale složitější
- Jiné (napíšu)

**Odpověď:**

### Q3.4 Cache
- **★ Ano: hash(text+engine+hlas+rychlost) → WAV v `~/.dsh/phononspeak-cache`, LRU ~200 MB**
- Jen paměťová cache pro posledních N vět
- Žádná cache (vždy syntetizovat)
- Jiné (napíšu)

**Odpověď:**

### Q3.5 Kde končí vygenerované audio?
- **★ Jen cache + dočasné soubory, které se uklidí** (žádná galerie)
- `~/.dsh/phononspeak-outputs/` s historií (dá se přehrát zpětně)
- Do pracovního adresáře projektu
- Jiné (napíšu)

**Odpověď:**

### Q3.6 Soukromí a logy
- **★ Vše lokálně; text se nikam neposílá; log jen metadat (délka, engine, trvání), ne text**
- Logovat i text (pro ladění), s automatickým smazáním po 7 dnech
- Žádné logy
- Jiné (napíšu)

**Odpověď:**

---

## R4 — Repo a dokumentace

### Q4.1 Licence repa
- **★ MIT** (jako `dsh-video`, `dsh-agent-voice`; komerčně přívětivé)
- Apache-2.0 (patentová klauzule)
- Jiná (napíšu)

**Odpověď:**

### Q4.2 Způsob distribuce
- **★ Veřejné GitHub repo + instalace přes `plugin_manager install_bundle` (file:/git)**, později npm
- Hned npm balíček `dsh-phononspeak` (vyžaduje npm účet)
- Jen GitHub repo, bez npm
- Jiné (napíšu)

**Odpověď:**

### Q4.3 Market index (katalog pluginů)
- **★ Ano: `index.json` na GitHub Pages tohoto repa** (plugin půjde najít v Plugin Market)
- Zatím ne — stačí přímá instalace
- Přidat do existujícího indexu, který už máš (`easonmws.github.io/dsh-plugin-health`)
- Jiné (napíšu)

**Odpověď:**

### Q4.4 Dokumentace
- **★ `README.md` (EN) + `README.cs.md` (CS) s přepínačem v hlavičce, `docs/` (architektura, hlasy a licence, soukromí), `CHANGELOG.md`**
- Jen anglicky
- Jen česky
- Víc: tutoriál, GIFy, ukázky zvuku v repu
- Jiné (napíšu)

**Odpověď:**

### Q4.5 Kvalita a CI
- **★ GitHub Actions: syntax check + `npm pack` + README odkaz check; bez síťových testů**
- Bez CI (ruční kontrola)
- CI včetně testu, že se plugin načte v Harnessu (náročné)
- Jiné (napíšu)

**Odpověď:**

### Q4.6 Verzování
- **★ Semver od 0.1.0, `CHANGELOG.md` vedený od začátku**
- 1.0.0 hned
- Jiné (napíšu)

**Odpověď:**

---

## R5 — Akceptace a publikace

### Q5.1 Co znamená „hotovo" pro první verzi?
- **★ Všech 7 bodů z `PROJECT_BRIEF.md` §9** (instalace, speak, stop, shrnutí, volání, nastavení, docs)
- Menší: jen speak + stop + settings
- Větší: i klonování a historie
- Jiné (napíšu)

**Odpověď:**

### Q5.2 Můžu plugin nainstalovat do tohoto profilu (`desktop`) a testovat živě?
- **★ Ano, nainstaluj a ukaž mi to v UI** (včetně zvukové ukázky)
- Ne, jen připrav soubory; instalaci udělám sám
- Nainstaluj, ale bez zásahu do `dsh-agent-voice` nastavení
- Jiné (napíšu)

**Odpověď:**

### Q5.3 Publikace repa
- **★ Založ repo `meliodascz89/dsh-phononspeak` jako veřejné až po tvém schválení obsahu**
- Založ hned veřejné a průběžně pushuj
- Založ privátní, veřejné později
- Nepublikuj, jen lokálně

**Odpověď:**

### Q5.4 Chceš nejdřív slyšet vzorky hlasů?
- **★ Ano: vygeneruj 3–4 vzorky (say, piper, pocket, klon) a nech mě vybrat výchozí**
- Ne, rozhodni podle měření a doporučení
- Jen pocket a piper
- Jiné (napíšu)

**Odpověď:**

### Q5.5 Rozsah a tempo
- **★ Iterativně: v0.1 funkční celek → ukázka → doladit**
- Najednou vše podle zadání, ukaž až hotové
- Nejmenší možný prototyp (speak + stop) a zbytek později
- Jiné (napíšu)

**Odpověď:**
