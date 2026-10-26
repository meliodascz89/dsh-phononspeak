//
//  client.js — the Web half: one settings page, one overlay player, one tool card.
//
//  WHY THE UI READS THROUGH HTTP INSTEAD OF A SETTINGS SERVICE:
//  0.2.x removed the settings namespace API that the older voice plugins wrote
//  through, so the browser cannot own this state. The Host owns the queue, the
//  settings file and the audio files; the only honest contract for the Web half
//  is "ask for the state" and "post a change". Keeping every write on the same
//  two routes is also what makes it impossible for the settings page and the
//  player to disagree after a reload.
//
//  WHY ONE MODULE-LEVEL STORE: the settings page, the frame overlay and every
//  tool card are mounted by three unrelated slots. They cannot share a React
//  provider, and two independent pollers would ask the Host different questions
//  at different times. One store, one timer, one `useSyncExternalStore` snapshot.
//
//  WHY ONE HTMLAudioElement: the overlay and a tool card can both be visible,
//  and a second element would speak the same job twice. The player below is a
//  singleton; components only read its snapshot and ask it to pause/resume.
//  The authority for *who plays* is the Host: `current.owner` says "browser" or
//  "system", and the browser stays silent under `system` even if it could play.
//
//  Autoplay is treated as a privilege, not a right: a rejected `play()` is a
//  normal state that shows a "Přehrát" button, never an exception escaping into
//  render.
//
//  Colours and type come from Harness theme tokens, with `currentColor`/`inherit`
//  fallbacks so a token rename degrades instead of producing an unreadable pane.
//

window.__ModuleLoader__.load({
  id: "dsh-phononspeak",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Package name; must match package.json and lib/contract.js. */
    const PLUGIN_ID = "dsh-phononspeak";
    /** Locale namespace owned by this module. */
    const NS = "phononspeak";

    /**
     * Routes from lib/contract.js, repeated literally because this module is
     * loaded as a browser blob and cannot import the contract. test/client-strings
     * checks that these literals stay present.
     */
    const ROUTES = Object.freeze({
      state: "/dsh-phononspeak/state",
      config: "/dsh-phononspeak/config",
      action: "/dsh-phononspeak/action",
      presence: "/dsh-phononspeak/presence",
      setup: "/dsh-phononspeak/setup",
      audio: "/dsh-phononspeak/audio/",
    });

    // Visible: fast enough that a new job appears while the user is looking.
    // Hidden: the Host may hand playback to `afplay`, so polling only guards the
    // queue and the attention banner; five seconds keeps a background tab quiet.
    const POLL_VISIBLE_MS = 1000;
    const POLL_HIDDEN_MS = 5000;
    // Sliders and text fields coalesce; toggles and selects go immediately.
    const CONFIG_DEBOUNCE_MS = 400;
    const REQUEST_TIMEOUT_MS = 8000;
    const SAVED_INDICATOR_MS = 2000;
    // A 10 ms silent WAV, played once inside the first user gesture. Web Audio
    // and <audio> both refuse to start without one, and a voice plugin that
    // silently refuses to speak is indistinguishable from a broken plugin.
    const SILENT_WAV =
      "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const MAX_CHARS_MIN = 100;
    const MAX_CHARS_MAX = 1200;
    const SPEED_MIN = 0.7;
    const SPEED_MAX = 1.6;

    // Settings fallback used only before the first successful poll. It mirrors
    // lib/contract.js DEFAULTS so the controls are controlled on first paint;
    // the Host's state always wins afterwards.
    const FALLBACK_CONFIG = Object.freeze({
      enabled: true,
      engine: "auto",
      voice: "M1",
      language: "cs",
      speed: 1,
      volume: 1,
      autoSummary: false,
      attentionRepeatSec: 0,
      systemPlayback: true,
      notify: true,
      dndFrom: "",
      dndTo: "",
      commercialMode: true,
      allowPersonalVoice: false,
      maxChars: 300,
      voices: [],
    });

    // MARK: - Dictionaries
    //
    // These are the same keys as locale/cs.json and locale/en.json. They are
    // duplicated rather than fetched so the first paint has text even when the
    // Host route is down, and so the package carries its own UI strings.
    //
    const DICTS = {
      en: {
        meta: {
          title: "Phononspeak — agent voice",
          description:
            "Local Czech-first voice for DeepSeek Harness: reads answer summaries aloud and calls you back to the computer.",
        },
        "settings.title": "Phononspeak",
        "page.title": "Agent voice",
        "page.subtitle":
          "Local speech, no cloud and no API key. This page controls what is read, how it sounds, and where it plays.",
        "page.close": "Done",
        "page.offline": "Offline",
        "page.offlineHint":
          "The plugin host is not answering. The queue is paused; last known settings are shown until the connection returns.",
        "page.retry": "Try again",
        "page.loading": "Loading the current voice state…",
        "common.saved": "Saved",
        "common.saving": "Saving…",
        "common.working": "Working…",
        "common.actionFailed": "The action failed.",
        "common.saveError": "Not saved",
        "common.seconds": "{value} s",
        "common.percent": "{value} %",
        "common.none": "None",
        "common.unknown": "Unknown",
        "common.yes": "Yes",
        "common.no": "No",
        "common.play": "Play",
        "common.pause": "Pause",
        "common.resume": "Resume",
        "common.stop": "Stop",
        "common.test": "Test",
        "common.dismiss": "Dismiss",
        "common.close": "Close",
        "common.cancel": "Cancel",
        "common.retry": "Retry",
        "status.title": "Status",
        "status.enabled": "Voice enabled",
        "status.enabledHint": "When off, the agent stays silent and nothing is queued.",
        "status.output": "Output",
        "status.output.browser": "In this browser",
        "status.output.system": "In the desktop app",
        "status.engine": "Engine in use",
        "status.engineAuto": "auto → {engine}",
        "status.queue": "Queued",
        "status.lastError": "Last error",
        "status.noError": "No error",
        "status.test": "Test voice",
        "status.stop": "Stop speaking",
        "status.version": "Plugin version {version}",
        "voice.title": "Voice",
        "voice.engine": "Engine",
        "voice.engineAuto": "Automatic (first available)",
        "voice.voice": "Voice",
        "voice.language": "Language",
        "voice.language.cs": "Czech",
        "voice.language.en": "English",
        "voice.speed": "Speed",
        "voice.volume": "Volume",
        "voice.measurement": "Measurement",
        "voice.noVoices": "No voice matches this engine and language.",
        "voice.cloneSuffix": "clone",
        "voice.ready": "ready",
        "voice.unavailable": "unavailable",
        "voice.notInstalled": "not installed",
        "voice.latency": "{value} ms first audio",
        "reading.title": "What gets read",
        "reading.autoSummary": "Read a summary after every answer",
        "reading.autoSummaryHint":
          "When on, the model sends a 1–3 sentence summary after each answer and the plugin reads it. When off, only explicit tool calls speak.",
        "reading.maxChars": "Maximum characters",
        "reading.maxCharsHint": "100–1200. Longer text is shortened and the shortening is announced.",
        "reading.repeat": "Repeat the attention call",
        "reading.repeat.once": "Once",
        "reading.repeat.every": "Every {value} s",
        "reading.notify": "Desktop notification",
        "reading.notifyHint": "Send a macOS notification together with an attention call.",
        "reading.systemPlayback": "Play without a visible browser",
        "reading.systemPlaybackHint":
          "Use the system player when the tab is hidden or closed. When off, hidden tabs stay silent.",
        "reading.dnd": "Do not disturb",
        "reading.dndFrom": "From",
        "reading.dndTo": "To",
        "reading.dndHint": "Local time. Leave both empty to disable the quiet window.",
        "privacy.title": "Privacy and rights",
        "privacy.commercial": "Commercial mode",
        "privacy.commercialHint":
          "Refuse engines whose output cannot be used commercially. Turn this off only for personal, non-commercial work.",
        "privacy.allowPersonal": "Allow macOS `say` (personal use only)",
        "privacy.allowPersonalWarning":
          "macOS `say` output is licensed for personal, non-commercial use only. By enabling it you acknowledge you may not publish or commercially use the output.",
        "privacy.local": "Nothing leaves this machine",
        "privacy.localHint":
          "Text is synthesized locally. No audio or text is uploaded; the only network traffic is between this page and the local plugin host.",
        "engines.title": "Engines & models",
        "engines.install": "Install",
        "engines.repair": "Repair",
        "engines.installing": "Provisioning…",
        "engines.available": "available",
        "engines.unavailable": "unavailable",
        "engines.installed": "installed",
        "engines.notInstalled": "not installed",
        "engines.license": "Licence",
        "engines.size": "Size",
        "engines.runtime": "Runtime",
        "engines.notes": "Notes",
        "engines.reason": "Reason",
        "engines.setupRunning": "Running since {time}",
        "engines.setupDone": "Ready",
        "engines.setupFailed": "Provisioning failed",
        "engines.none": "The host has not reported any engines yet.",
        "engines.pocketNote":
          "Pocket TTS Czech (vvolhejn/pocket-tts-czech) is CC-BY-4.0; attribution belongs to ÚFAL. Voice cloning is opt-in and works only from a recording you have the right to use.",
        "engines.sayNote":
          "macOS `say` is personal, non-commercial only. It needs the explicit opt-in in Privacy and rights.",
        "clones.title": "Cloned voices",
        "clones.intro":
          "Only the pocket engine can clone. Use your own voice, or a voice for which you have written consent.",
        "clones.note": "A clone is a reference to a local wav file; the file is never uploaded.",
        "clones.empty": "No cloned voice yet.",
        "clones.name": "Name",
        "clones.namePlaceholder": "My voice",
        "clones.path": "Absolute path to a wav file",
        "clones.pathPlaceholder": "/Users/me/voices/my-voice.wav",
        "clones.pathMustBeAbsolute": "The path must be absolute (it must start with /).",
        "clones.rights": "I have the right to use this voice",
        "clones.add": "Add voice",
        "clones.adding": "Adding…",
        "clones.remove": "Remove",
        "clones.removing": "Removing…",
        "clones.createdAt": "Added {date}",
        "clones.engine": "Engine",
        "clones.rightsRequired": "Confirm the rights before adding a voice.",
        "overlay.attentionTitle": "The agent is calling you",
        "overlay.attentionHint": "A decision is waiting. The call repeats until you answer.",
        "overlay.ack": "I'm here",
        "overlay.playerTitle": "Speaking now",
        "overlay.systemTitle": "Playing in the app",
        "overlay.systemHint": "The desktop player owns this job; the browser stays silent.",
        "overlay.preparing": "Preparing speech…",
        "overlay.blocked": "Autoplay was blocked. Start it here.",
        "overlay.queue": "{count} waiting",
        "overlay.stopped": "Stopped",
        "overlay.done": "Played",
        "overlay.attentionRepeat": "Repeats every {value} s",
        "overlay.actionFailed": "The host rejected the action: {error}",
        "tool.preparing": "Preparing speech…",
        "tool.starting": "Sending to the speech queue…",
        "tool.action": "Action",
        "tool.engine": "Engine",
        "tool.voice": "Voice",
        "tool.segments": "Segments",
        "tool.duration": "Duration",
        "tool.replay": "Play again",
        "tool.replaying": "Sending…",
        "tool.replayFailed": "Replay failed: {error}",
        "tool.error": "Speech failed: {error}",
        "tool.noText": "No spoken text was returned.",
        "tool.unknownKind": "speak",
        "tool.kind.summary": "summary",
        "tool.kind.manual": "manual",
        "tool.kind.attention": "attention",
        "tool.kind.test": "test",
        "tool.kind.question": "question",
      },
      cs: {
        meta: {
          title: "Phononspeak — hlas agenta",
          description:
            "Lokální český hlas pro DeepSeek Harness: čte shrnutí odpovědí nahlas a zavolá vás k počítači.",
        },
        "settings.title": "Phononspeak",
        "page.title": "Hlas agenta",
        "page.subtitle":
          "Lokální řeč, žádný cloud a žádný API klíč. Tato stránka řídí, co se čte, jak to zní a kde se to přehrává.",
        "page.close": "Hotovo",
        "page.offline": "Offline",
        "page.offlineHint":
          "Hostitel pluginu neodpovídá. Fronta je pozastavená; do obnovení spojení se zobrazují poslední známá nastavení.",
        "page.retry": "Zkusit znovu",
        "page.loading": "Načítám aktuální stav hlasu…",
        "common.saved": "Uloženo",
        "common.saving": "Ukládám…",
        "common.working": "Pracuji…",
        "common.actionFailed": "Akce selhala.",
        "common.saveError": "Neuloženo",
        "common.seconds": "{value} s",
        "common.percent": "{value} %",
        "common.none": "Žádný",
        "common.unknown": "Neznámé",
        "common.yes": "Ano",
        "common.no": "Ne",
        "common.play": "Přehrát",
        "common.pause": "Pozastavit",
        "common.resume": "Pokračovat",
        "common.stop": "Zastavit",
        "common.test": "Vyzkoušet",
        "common.dismiss": "Zavřít",
        "common.close": "Zavřít",
        "common.cancel": "Zrušit",
        "common.retry": "Zkusit znovu",
        "status.title": "Stav",
        "status.enabled": "Hlas zapnutý",
        "status.enabledHint": "Když je vypnutý, agent mlčí a nic se nezařazuje do fronty.",
        "status.output": "Výstup",
        "status.output.browser": "V tomto prohlížeči",
        "status.output.system": "V desktopové aplikaci",
        "status.engine": "Použitý engine",
        "status.engineAuto": "auto → {engine}",
        "status.queue": "Ve frontě",
        "status.lastError": "Poslední chyba",
        "status.noError": "Bez chyby",
        "status.test": "Vyzkoušet hlas",
        "status.stop": "Zastavit řeč",
        "status.version": "Verze pluginu {version}",
        "voice.title": "Hlas",
        "voice.engine": "Engine",
        "voice.engineAuto": "Automaticky (první dostupný)",
        "voice.voice": "Hlas",
        "voice.language": "Jazyk",
        "voice.language.cs": "Čeština",
        "voice.language.en": "Angličtina",
        "voice.speed": "Rychlost",
        "voice.volume": "Hlasitost",
        "voice.measurement": "Měření",
        "voice.noVoices": "Tomuto enginu a jazyku neodpovídá žádný hlas.",
        "voice.cloneSuffix": "klon",
        "voice.ready": "připraveno",
        "voice.unavailable": "nedostupné",
        "voice.notInstalled": "nenainstalováno",
        "voice.latency": "{value} ms do prvního zvuku",
        "reading.title": "Co se čte",
        "reading.autoSummary": "Číst shrnutí po každé odpovědi",
        "reading.autoSummaryHint":
          "Když je zapnuto, model po každé odpovědi pošle 1–3 věty shrnutí a plugin je přečte. Když je vypnuto, mluví jen explicitní volání nástroje.",
        "reading.maxChars": "Maximální počet znaků",
        "reading.maxCharsHint": "100–1200. Delší text se zkrátí a zkrácení se oznámí.",
        "reading.repeat": "Opakovat volání k počítači",
        "reading.repeat.once": "Jednou",
        "reading.repeat.every": "Každých {value} s",
        "reading.notify": "Notifikace na ploše",
        "reading.notifyHint": "Poslat macOS notifikaci spolu s voláním k počítači.",
        "reading.systemPlayback": "Přehrát i bez viditelného prohlížeče",
        "reading.systemPlaybackHint":
          "Použít systémový přehrávač, když je karta skrytá nebo zavřená. Když je vypnuto, skrytá karta mlčí.",
        "reading.dnd": "Nerušit",
        "reading.dndFrom": "Od",
        "reading.dndTo": "Do",
        "reading.dndHint": "Místní čas. Nechte obě pole prázdná pro vypnutí klidového okna.",
        "privacy.title": "Soukromí a práva",
        "privacy.commercial": "Komerční režim",
        "privacy.commercialHint":
          "Odmítnout enginy, jejichž výstup nelze použít komerčně. Vypněte jen pro osobní, nekomerční práci.",
        "privacy.allowPersonal": "Povolit macOS `say` (jen osobní použití)",
        "privacy.allowPersonalWarning":
          "Výstup macOS `say` je licencován pouze pro osobní, nekomerční použití. Zapnutím berete na vědomí, že výstup nesmíte zveřejnit ani použít komerčně.",
        "privacy.local": "Nic neopouští tento počítač",
        "privacy.localHint":
          "Text se syntetizuje lokálně. Žádné audio ani text se neodesílá; jediná síťová komunikace je mezi touto stránkou a místním hostitelem pluginu.",
        "engines.title": "Engine a modely",
        "engines.install": "Nainstalovat",
        "engines.repair": "Opravit",
        "engines.installing": "Zřizuji…",
        "engines.available": "dostupné",
        "engines.unavailable": "nedostupné",
        "engines.installed": "nainstalováno",
        "engines.notInstalled": "nenainstalováno",
        "engines.license": "Licence",
        "engines.size": "Velikost",
        "engines.runtime": "Runtime",
        "engines.notes": "Poznámky",
        "engines.reason": "Důvod",
        "engines.setupRunning": "Běží od {time}",
        "engines.setupDone": "Připraveno",
        "engines.setupFailed": "Zřízení selhalo",
        "engines.none": "Hostitel zatím nehlásí žádné enginy.",
        "engines.pocketNote":
          "Pocket TTS Czech (vvolhejn/pocket-tts-czech) je CC-BY-4.0; atribuce patří ÚFAL. Klonování je opt-in a funguje jen z nahrávky, ke které máte právo.",
        "engines.sayNote":
          "macOS `say` je jen pro osobní, nekomerční použití. Vyžaduje výslovné povolení v Soukromí a právech.",
        "clones.title": "Klonované hlasy",
        "clones.intro":
          "Klonovat umí jen engine pocket. Použijte vlastní hlas, nebo hlas, ke kterému máte písemný souhlas.",
        "clones.note": "Klon je odkaz na místní wav soubor; soubor se nikam neodesílá.",
        "clones.empty": "Zatím žádný klonovaný hlas.",
        "clones.name": "Název",
        "clones.namePlaceholder": "Můj hlas",
        "clones.path": "Absolutní cesta k wav souboru",
        "clones.pathPlaceholder": "/Users/já/hlasy/muj-hlas.wav",
        "clones.pathMustBeAbsolute": "Cesta musí být absolutní (musí začínat /).",
        "clones.rights": "Mám právo tento hlas použít",
        "clones.add": "Přidat hlas",
        "clones.adding": "Přidávám…",
        "clones.remove": "Odebrat",
        "clones.removing": "Odebírám…",
        "clones.createdAt": "Přidáno {date}",
        "clones.engine": "Engine",
        "clones.rightsRequired": "Před přidáním hlasu potvrďte práva.",
        "overlay.attentionTitle": "Agent tě volá",
        "overlay.attentionHint": "Čeká rozhodnutí. Volání se opakuje, dokud neodpovíš.",
        "overlay.ack": "Jsem tady",
        "overlay.playerTitle": "Mluví teď",
        "overlay.systemTitle": "Hraje v aplikaci",
        "overlay.systemHint": "Tento job vlastní desktopový přehrávač; prohlížeč mlčí.",
        "overlay.preparing": "Připravuji řeč…",
        "overlay.blocked": "Autoplay byl zablokován. Spusťte přehrávání zde.",
        "overlay.queue": "{count} čeká",
        "overlay.stopped": "Zastaveno",
        "overlay.done": "Přehráno",
        "overlay.attentionRepeat": "Opakuje se každých {value} s",
        "overlay.actionFailed": "Hostitel akci odmítl: {error}",
        "tool.preparing": "Připravuji řeč…",
        "tool.starting": "Posílám do fronty řeči…",
        "tool.action": "Akce",
        "tool.engine": "Engine",
        "tool.voice": "Hlas",
        "tool.segments": "Segmenty",
        "tool.duration": "Trvání",
        "tool.replay": "Přehrát znovu",
        "tool.replaying": "Posílám…",
        "tool.replayFailed": "Přehrání selhalo: {error}",
        "tool.error": "Řeč selhala: {error}",
        "tool.noText": "Nebyl vrácen žádný mluvený text.",
        "tool.unknownKind": "promluva",
        "tool.kind.summary": "shrnutí",
        "tool.kind.manual": "ručně",
        "tool.kind.attention": "volání",
        "tool.kind.test": "test",
        "tool.kind.question": "otázka",
      },
    };

    // The locale service is installed in apply(); components read this object so
    // a slot component can stay a plain module-level function.
    const localeRef = { current: null };
    const EMPTY_LOCALE_SNAPSHOT = Object.freeze({ active: "en", revision: 0, locales: [] });

    function fallbackLanguage() {
      try {
        const language =
          typeof navigator !== "undefined" && typeof navigator.language === "string"
            ? navigator.language
            : "en";
        return language.toLowerCase().startsWith("cs") ? "cs" : "en";
      } catch {
        return "en";
      }
    }

    function lookup(dict, key, params) {
      const template =
        dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
      if (typeof template !== "string") return key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }

    function fallbackT(key, params) {
      const language = fallbackLanguage();
      const dict = DICTS[language] || DICTS.en;
      const value = lookup(dict, key, params);
      return value === key ? lookup(DICTS.en, key, params) : value;
    }

    /**
     * Subscribe to locale revisions and return the namespaced translate function.
     * `bind` returns a stable function that reads the live dictionaries, so calling
     * it after the re-render triggered by this subscription is enough.
     */
    function useT() {
      const locale = localeRef.current;
      const subscribe = React.useCallback(
        (listener) => (locale ? locale.subscribe(listener) : () => {}),
        [locale],
      );
      const getSnapshot = React.useCallback(
        () => (locale ? locale.getSnapshot() : EMPTY_LOCALE_SNAPSHOT),
        [locale],
      );
      React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      return React.useMemo(
        () => (locale ? locale.bind(NS) : fallbackT),
        [locale],
      );
    }

    // MARK: - Fetch helpers
    //
    // Every call is same-origin and credential-carrying. The Host answers JSON;
    // a non-2xx response still carries `{ok:false,error}` often enough that we
    // parse the body before deciding what happened.

    function errorText(error) {
      if (error === null || error === undefined) return "unknown";
      const raw =
        typeof error === "string"
          ? error
          : typeof error.message === "string"
            ? error.message
            : String(error);
      return raw.length > 300 ? `${raw.slice(0, 297)}…` : raw;
    }

    /**
     * Browser-half transport.
     *
     * MEASURED on 0.2.1-rc.3: a static bundle's page has NO settings service and
     * its plain `fetch('/dsh-phononspeak/...')` is not answered by the Host
     * route table (the Desktop renderer carries host work over the Connection
     * RPC carrier, not over HTTP). So every call goes through the package's
     * Typert Remote namespace `phononspeak/*`; the HTTP route is kept only as a
     * fallback for a plain `dsh web` deployment and for curl debugging.
     */
    let rpcFactory = null;
    const AUDIO_URLS = new Map();

    function unwrapEnvelope(envelope) {
      if (envelope && typeof envelope === "object" && envelope.ok === false) {
        const message =
          envelope.error && typeof envelope.error.message === "string"
            ? envelope.error.message
            : "RPC call failed";
        throw new Error(message);
      }
      if (envelope && typeof envelope === "object" && envelope.ok === true && "value" in envelope) {
        return envelope.value;
      }
      return envelope;
    }

    function methodsForPath(path, method) {
      if (path === ROUTES.state) return ["state", "none"];
      if (path === ROUTES.config) return ["config", "body"];
      if (path === ROUTES.action) return ["action", "body"];
      if (path === ROUTES.presence) return ["presence", "body"];
      if (path === ROUTES.setup) return method === "GET" ? ["setupStatus", "none"] : ["setup", "body"];
      return null;
    }

    async function requestAudio(id) {
      if (rpcFactory === null) return null;
      const result = await rpcFactory("audio", { id });
      return result && typeof result.dataUrl === "string" ? result.dataUrl : null;
    }

    async function requestJson(path, options) {
      const opts = options || {};
      const method = opts.method || "GET";
      const keepalive = opts.keepalive === true;
      const mapped = methodsForPath(path, method);
      if (mapped !== null && rpcFactory !== null) {
        const args = mapped[1] === "body" ? opts.body || {} : null;
        return await rpcFactory(mapped[0], args);
      }
      if (typeof fetch !== "function") throw new Error("fetch is unavailable");

      const init = {
        method,
        credentials: "same-origin",
        cache: "no-store",
        keepalive,
      };
      if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
        init.headers = { "content-type": "application/json" };
      }
      let controller = null;
      let timer = null;
      if (typeof AbortController === "function" && !keepalive) {
        controller = new AbortController();
        init.signal = controller.signal;
        timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      }
      try {
        const response = await fetch(path, init);
        const text = await response.text();
        let parsed = null;
        if (text !== "") {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }
        if (!response.ok) {
          const failure = new Error(
            (parsed && typeof parsed.error === "string" && parsed.error) ||
              `HTTP ${response.status}`,
          );
          failure.status = response.status;
          failure.body = parsed;
          throw failure;
        }
        if (parsed === null) throw new Error("the host returned invalid JSON");
        return parsed;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    async function callAction(body) {
      try {
        const response = await requestJson(ROUTES.action, { method: "POST", body });
        if (response && response.ok === false) {
          return { ok: false, error: errorText(response.error || "action rejected") };
        }
        return response || { ok: false, error: "empty response" };
      } catch (error) {
        return {
          ok: false,
          error: errorText((error && error.body && error.body.error) || error),
          status: error && error.status,
        };
      }
    }

    async function callSetup(engine) {
      try {
        const response = await requestJson(ROUTES.setup, { method: "POST", body: { engine } });
        if (response && response.ok === false) {
          return { ok: false, error: errorText(response.error || "setup rejected") };
        }
        return response || { ok: false, error: "empty response" };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }

    function isVisible() {
      try {
        return typeof document === "undefined" || document.visibilityState === "visible";
      } catch {
        return true;
      }
    }

    // MARK: - State store
    //
    // Snapshot shape is deliberately small and stable:
    //   { status, state, error, updatedAt, signature }
    // `signature` folds the whole Host state into one string so an unchanged poll
    // does not re-render the settings draft. Offline is a state, not an exception.

    const store = {
      snapshot: Object.freeze({
        status: "loading",
        state: null,
        error: null,
        updatedAt: 0,
        signature: "loading",
      }),
      subscribers: new Set(),
      started: false,
      timer: null,
      inflight: null,
      listeners: null,
      /** Highest `state.now` accepted, so a slow poll cannot undo a fresh save. */
      serverNow: 0,

      getSnapshot() {
        return this.snapshot;
      },

      subscribe(listener) {
        this.subscribers.add(listener);
        return () => {
          this.subscribers.delete(listener);
        };
      },

      emit() {
        for (const listener of [...this.subscribers]) {
          try {
            listener();
          } catch {
            // A broken consumer must not stop the poll loop.
          }
        }
      },

      publish(next, force) {
        if (!force && next.signature === this.snapshot.signature && next.status === this.snapshot.status) {
          return;
        }
        this.snapshot = next;
        this.emit();
      },

      acceptServerState(state) {
        const now = Number(state && state.now);
        if (Number.isFinite(now) && now > 0) {
          if (now < this.serverNow) return false;
          this.serverNow = now;
        }
        return true;
      },

      publishOnline(state, output) {
        if (!state || typeof state !== "object") return;
        if (!this.acceptServerState(state)) return;
        const merged =
          output && state.output !== output ? Object.assign({}, state, { output }) : state;
        this.publish({
          status: "online",
          state: merged,
          error: null,
          updatedAt: Date.now(),
          signature: `online:${JSON.stringify(merged)}`,
        });
      },

      /** Adopt a state returned by POST /config without waiting for the next poll. */
      applyServerState(state) {
        if (!state || typeof state !== "object") return;
        if (!this.acceptServerState(state)) return;
        this.publish({
          status: "online",
          state,
          error: null,
          updatedAt: Date.now(),
          signature: `online:${JSON.stringify(state)}`,
        });
      },

      publishOffline(error) {
        // Keep the last state so the settings page can still show (and edit)
        // cached values; only the status chip and the error line say "offline".
        // Repeated identical failures must not re-render the page every second.
        const message = errorText(error);
        const signature = `offline:${message}`;
        if (this.snapshot.status === "offline" && this.snapshot.signature === signature) {
          return;
        }
        this.publish({
          status: "offline",
          state: this.snapshot.state,
          error: message,
          updatedAt: Date.now(),
          signature,
        });
      },

      sendPresence(visible, keepalive) {
        return requestJson(ROUTES.presence, {
          method: "POST",
          body: { visible },
          keepalive: !!keepalive,
        }).catch(() => null);
      },

      poll() {
        if (this.inflight) return this.inflight;
        const visible = isVisible();
        const stateRequest = requestJson(ROUTES.state, { method: "GET" });
        const presenceRequest = this.sendPresence(visible, false);
        this.inflight = Promise.allSettled([stateRequest, presenceRequest])
          .then(([stateResult, presenceResult]) => {
            const presence =
              presenceResult.status === "fulfilled" ? presenceResult.value : null;
            if (stateResult.status === "fulfilled") {
              const value = stateResult.value;
              if (value && value.ok !== false) {
                this.publishOnline(value, presence && presence.output);
                return;
              }
              this.publishOffline((value && value.error) || "state rejected");
              return;
            }
            this.publishOffline(stateResult.reason);
          })
          .finally(() => {
            this.inflight = null;
          });
        return this.inflight;
      },

      pollNow() {
        return this.poll();
      },

      arm() {
        if (this.timer !== null) clearTimeout(this.timer);
        const delay = isVisible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.poll().finally(() => this.arm());
        }, delay);
      },

      start() {
        if (this.started) return;
        this.started = true;
        this.listeners = {
          visibility: () => {
            // A tab that just became visible should not wait up to five seconds.
            this.arm();
            this.poll();
          },
          pagehide: () => {
            if (this.timer !== null) {
              clearTimeout(this.timer);
              this.timer = null;
            }
            // Best effort: let the Host switch to `afplay` before the tab dies.
            this.sendPresence(false, true);
          },
          pageshow: (event) => {
            if (event && event.persisted) {
              this.arm();
              this.poll();
            }
          },
        };
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", this.listeners.visibility);
        }
        if (typeof window !== "undefined") {
          window.addEventListener("pagehide", this.listeners.pagehide);
          window.addEventListener("pageshow", this.listeners.pageshow);
        }
        player.attach();
        this.arm();
        this.poll();
      },

      stop() {
        if (!this.started) return;
        this.started = false;
        if (this.timer !== null) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        if (typeof document !== "undefined" && this.listeners) {
          document.removeEventListener("visibilitychange", this.listeners.visibility);
        }
        if (typeof window !== "undefined" && this.listeners) {
          window.removeEventListener("pagehide", this.listeners.pagehide);
          window.removeEventListener("pageshow", this.listeners.pageshow);
        }
        this.listeners = null;
        player.detach();
      },
    };

    function useAppState() {
      return React.useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => store.getSnapshot(),
        () => store.getSnapshot(),
      );
    }

    // MARK: - Player
    //
    // The player reports *local* playback state. Server state is the source of
    // truth for the job, but only this module knows whether the browser actually
    // started the audio, was blocked by autoplay, or was paused by the user.

    function absoluteUrl(url) {
      try {
        return new URL(url, typeof location === "undefined" ? undefined : location.href).href;
      } catch {
        return url;
      }
    }

    function clampNumber(value, min, max, fallback) {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, number));
    }

    const player = {
      audio: null,
      subscribers: new Set(),
      snapshot: Object.freeze({
        jobId: null,
        index: 0,
        playing: false,
        paused: false,
        blocked: false,
        pending: false,
        stopped: false,
        done: false,
        owner: null,
        volume: 1,
        error: null,
      }),
      current: null,
      ignoreId: null,
      awaitingFinish: false,
      finishedId: null,
      starting: false,
      attached: false,
      detachStore: null,
      unlocked: false,
      blockedReportedFor: null,

      getSnapshot() {
        return this.snapshot;
      },

      subscribe(listener) {
        this.subscribers.add(listener);
        return () => {
          this.subscribers.delete(listener);
        };
      },

      emit() {
        for (const listener of [...this.subscribers]) {
          try {
            listener();
          } catch {
            // ignore a consumer that unmounted mid-notification
          }
        }
      },

      patch(next) {
        let changed = false;
        const merged = Object.assign({}, this.snapshot);
        for (const key of Object.keys(next)) {
          if (merged[key] !== next[key]) {
            merged[key] = next[key];
            changed = true;
          }
        }
        if (!changed) return;
        this.snapshot = Object.freeze(merged);
        this.emit();
      },

      ensureAudio() {
        if (this.audio) return this.audio;
        if (typeof Audio !== "function") return null;
        const audio = new Audio();
        audio.preload = "auto";
        audio.addEventListener("ended", () => this.onEnded());
        audio.addEventListener("error", () =>
          this.patch({ playing: false, error: "audio" }),
        );
        this.audio = audio;
        return audio;
      },

      attach() {
        if (this.attached) return;
        this.attached = true;
        this.detachStore = store.subscribe(() => this.sync(store.getSnapshot().state));
        this.sync(store.getSnapshot().state);
      },

      detach() {
        if (this.detachStore) this.detachStore();
        this.detachStore = null;
        this.attached = false;
      },

      /** Apply the Host's job snapshot without ever starting a second element. */
      sync(state) {
        if (!state) return;
        const config = state.config || {};
        const volume = clampNumber(config.volume, 0, 1, 1);
        this.patch({ volume });
        if (this.audio) this.audio.volume = volume;

        const current = state.current || null;
        this.current = current;

        if (!current) {
          this.ignoreId = null;
          this.awaitingFinish = false;
          this.finishedId = null;
          this.hardReset();
          return;
        }

        // Stop was pressed for this job but the Host has not cleared `current`
        // yet. Stay silent instead of restarting on the next poll.
        if (current.id === this.ignoreId) {
          this.patch({
            jobId: current.id,
            owner: current.owner || "browser",
            playing: false,
            paused: false,
          });
          return;
        }
        this.ignoreId = null;

        if (current.owner !== "browser") {
          // The desktop app owns this one. Pause any local audio from a previous
          // job so the two channels cannot overlap.
          if (this.audio && !this.audio.paused) this.audio.pause();
          this.patch({
            jobId: current.id,
            owner: "system",
            index: 0,
            playing: false,
            paused: false,
            blocked: false,
            pending: false,
            stopped: false,
            done: false,
            error: null,
          });
          return;
        }

        if (this.snapshot.jobId !== current.id) {
          this.finishedId = null;
          this.awaitingFinish = false;
          this.patch({
            jobId: current.id,
            owner: "browser",
            index: 0,
            playing: false,
            paused: false,
            blocked: false,
            pending: true,
            stopped: false,
            done: false,
            error: null,
          });
          this.loadSegment(current, 0, true);
          return;
        }

        this.patch({ owner: "browser" });
        const segments = Array.isArray(current.segments) ? current.segments : [];
        const index = this.snapshot.index;
        if (
          index < segments.length &&
          !this.snapshot.playing &&
          !this.snapshot.paused &&
          !this.snapshot.blocked &&
          !this.snapshot.stopped &&
          !this.starting
        ) {
          const wanted = absoluteUrl(segments[index].url);
          if (!this.audio || this.audio.src !== wanted || this.audio.ended) {
            this.loadSegment(current, index, true);
          }
        }
        if (this.awaitingFinish) this.maybeFinish(current);
      },

      loadSegment(job, index, autoplay) {
        const segments = Array.isArray(job.segments) ? job.segments : [];
        const segment = segments[index];
        if (!segment || typeof segment.url !== "string" || segment.url === "") {
          // Synthesis may still be producing segments; the next poll retries.
          this.patch({ playing: false, pending: true });
          return;
        }
        const audio = this.ensureAudio();
        if (!audio) {
          this.patch({ blocked: true, pending: false });
          return;
        }
        const fallbackUrl = absoluteUrl(segment.url);
        const key = String(segment.audioId || segment.url);
        const apply = (url) => {
          if (audio.src !== url) {
            audio.src = url;
            audio.volume = this.snapshot.volume;
          }
          this.patch({
            jobId: job.id,
            index,
            pending: false,
            stopped: false,
            error: null,
          });
          if (autoplay) this.play();
        };
        const cached = AUDIO_URLS.get(key);
        if (typeof cached === "string") {
          apply(cached);
          return;
        }
        if (rpcFactory !== null && typeof segment.audioId === "string" && segment.audioId !== "") {
          // The segment bytes travel over RPC as a data URL; they are small
          // (one sentence), cached per audio id, and never re-fetched while the
          // page lives.
          requestAudio(segment.audioId)
            .then((dataUrl) => {
              if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
                AUDIO_URLS.set(key, dataUrl);
                apply(dataUrl);
              } else {
                apply(fallbackUrl);
              }
            })
            .catch(() => apply(fallbackUrl));
          return;
        }
        apply(fallbackUrl);
      },

      /**
       * Spend the first user gesture on a silent play so later, model-driven
       * audio is allowed by the autoplay policy. Safe to call repeatedly.
       */
      unlock() {
        if (this.unlocked) return;
        this.unlocked = true;
        try {
          const probe = new Audio(SILENT_WAV);
          probe.volume = 0;
          const result = probe.play();
          if (result && typeof result.then === "function") result.catch(() => {});
        } catch {
          /* the next real play() will report the block */
        }
      },

      play() {
        const audio = this.ensureAudio();
        if (!audio) {
          this.patch({ blocked: true });
          return;
        }
        this.patch({ stopped: false, error: null });
        this.starting = true;
        let result;
        try {
          result = audio.play();
        } catch {
          this.starting = false;
          this.patch({ playing: false, blocked: true });
          return;
        }
        if (result && typeof result.then === "function") {
          result
            .then(() => {
              this.starting = false;
              this.patch({ playing: true, paused: false, blocked: false });
            })
            .catch(() => {
              this.starting = false;
              // A rejected play() is the browser's autoplay policy, not a bug.
              // Tell the host once per job so it can speak through afplay
              // instead of letting the summary go unheard.
              this.patch({ playing: false, blocked: true });
              const jobId = this.snapshot.jobId;
              if (jobId && this.blockedReportedFor !== jobId) {
                this.blockedReportedFor = jobId;
                callAction({ action: "blocked", id: jobId }).then(() => store.pollNow()).catch(() => {});
              }
            });
        } else {
          this.starting = false;
          this.patch({ playing: true, paused: false, blocked: false });
        }
      },

      pause() {
        if (this.audio) this.audio.pause();
        this.patch({ playing: false, paused: true });
      },

      resume() {
        this.patch({ paused: false, blocked: false });
        this.play();
      },

      /** User-gesture start after autoplay rejection. */
      userPlay() {
        this.patch({ paused: false, blocked: false });
        this.play();
      },

      stop() {
        const id = this.current && this.current.id ? this.current.id : null;
        this.ignoreId = id;
        this.awaitingFinish = false;
        if (this.audio) this.audio.pause();
        this.patch({ playing: false, paused: false, stopped: true, blocked: false, done: false });
        callAction({ action: "stop" }).then(() => store.pollNow());
      },

      onEnded() {
        const job = this.current;
        this.starting = false;
        if (!job) {
          this.patch({ playing: false });
          return;
        }
        const segments = Array.isArray(job.segments) ? job.segments : [];
        const expected = segments[this.snapshot.index];
        // A late `ended` from the previous source must not advance the new job.
        if (
          expected &&
          this.audio &&
          this.audio.src !== absoluteUrl(expected.url)
        ) {
          return;
        }
        const next = this.snapshot.index + 1;
        if (next < segments.length) {
          this.patch({ playing: false, index: next });
          this.loadSegment(job, next, true);
          return;
        }
        this.patch({ playing: false });
        // If the Host has not marked the job complete yet, the next poll either
        // delivers more segments or lets us report `finished`.
        this.awaitingFinish = true;
        this.maybeFinish(job);
      },

      maybeFinish(job) {
        if (!job || job.complete !== true) return;
        if (this.finishedId === job.id) return;
        this.finishedId = job.id;
        this.awaitingFinish = false;
        // Hold the panel in a played state while the Host clears `current`,
        // otherwise a Play button flashes for the last second of the job.
        this.patch({ playing: false, done: true });
        callAction({ action: "finished", id: job.id }).then(() => store.pollNow());
      },

      hardReset() {
        if (this.audio) {
          this.audio.pause();
          this.audio.removeAttribute("src");
          try {
            this.audio.load();
          } catch {
            // no source to unload
          }
        }
        this.patch({
          jobId: null,
          index: 0,
          playing: false,
          paused: false,
          blocked: false,
          pending: false,
          stopped: false,
          done: false,
          owner: null,
          error: null,
        });
      },
    };

    function usePlayer() {
      return React.useSyncExternalStore(
        (listener) => player.subscribe(listener),
        () => player.getSnapshot(),
        () => player.getSnapshot(),
      );
    }

    // MARK: - Small presentational pieces

    function Section(props) {
      return h(
        "section",
        { className: "ps-section", "aria-labelledby": props.id },
        h("h2", { id: props.id, className: "ps-section-title" }, props.title),
        props.children,
      );
    }

    function Row(props) {
      return h(
        "div",
        { className: "ps-row" },
        h(
          "div",
          { className: "ps-row-label" },
          h("span", { className: "ps-label", id: props.labelId }, props.label),
          props.hint ? h("p", { className: "ps-hint" }, props.hint) : null,
        ),
        h("div", { className: "ps-row-control" }, props.children),
      );
    }

    function Toggle(props) {
      return h(
        "div",
        { className: "ps-toggle" },
        h(
          "label",
          { className: "ps-toggle-label", htmlFor: props.id },
          h("input", {
            id: props.id,
            type: "checkbox",
            checked: props.checked === true,
            disabled: props.disabled === true,
            onChange: (event) => props.onChange(event.target.checked),
          }),
          h("span", { className: "ps-toggle-text" }, props.label),
        ),
        props.hint ? h("p", { className: "ps-hint ps-toggle-hint" }, props.hint) : null,
      );
    }

    function Select(props) {
      return h(
        "select",
        {
          id: props.id,
          className: "ps-select",
          value: props.value,
          disabled: props.disabled === true,
          "aria-labelledby": props.labelId,
          onChange: (event) => props.onChange(event.target.value),
        },
        (props.options || []).map((option) =>
          h("option", { key: option.value, value: option.value }, option.label),
        ),
      );
    }

    function RangeField(props) {
      return h(
        "div",
        { className: "ps-range-wrap" },
        h(
          "label",
          { className: "ps-label", htmlFor: props.id },
          props.label,
          h("span", { className: "ps-value" }, props.format(props.value)),
        ),
        h("input", {
          id: props.id,
          className: "ps-range",
          type: "range",
          min: props.min,
          max: props.max,
          step: props.step,
          value: props.value,
          "aria-valuetext": props.format(props.value),
          onChange: (event) => props.onChange(Number(event.target.value)),
        }),
      );
    }

    function NumberField(props) {
      const [text, setText] = React.useState(String(props.value === undefined ? "" : props.value));
      React.useEffect(() => {
        setText(String(props.value === undefined ? "" : props.value));
      }, [props.value]);

      function commit() {
        const number = Number(text);
        if (!Number.isFinite(number)) {
          setText(String(props.value));
          return;
        }
        const clamped = clampNumber(number, props.min, props.max, props.value);
        setText(String(clamped));
        if (clamped !== props.value) props.onCommit(clamped);
      }

      return h("input", {
        id: props.id,
        className: "ps-input ps-input-number",
        type: "number",
        min: props.min,
        max: props.max,
        step: props.step || 1,
        value: text,
        "aria-labelledby": props.labelId,
        onChange: (event) => {
          const raw = event.target.value;
          setText(raw);
          const number = Number(raw);
          if (Number.isFinite(number) && number >= props.min && number <= props.max) {
            props.onCommit(number);
          }
        },
        onBlur: commit,
      });
    }

    function TimeField(props) {
      return h("input", {
        id: props.id,
        className: "ps-input ps-input-time",
        type: "time",
        value: props.value || "",
        onChange: (event) => props.onChange(event.target.value),
      });
    }

    function secondsLabel(t, value) {
      return t("common.seconds", { value });
    }

    function formatDate(value) {
      if (!value) return "";
      try {
        return new Date(value).toLocaleDateString();
      } catch {
        return String(value);
      }
    }

    function formatTime(value) {
      if (!value) return "";
      try {
        return new Date(value).toLocaleTimeString();
      } catch {
        return String(value);
      }
    }

    function statusErrorMessage(value) {
      if (value === null || value === undefined || value === "") return "";
      if (typeof value === "string") return value;
      if (typeof value === "object" && typeof value.message === "string") return value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    function resolvedEngine(state) {
      const engines = Array.isArray(state && state.engines) ? state.engines : [];
      const config = (state && state.config) || {};
      if (config.engine && config.engine !== "auto") {
        return engines.find((engine) => engine.id === config.engine) || null;
      }
      return engines.find((engine) => engine.available === true && engine.installed === true) || null;
    }

    function measurementFacts(t, state) {
      const engine = resolvedEngine(state);
      const facts = [];
      const sampleRate =
        (engine && (engine.sampleRate || engine.sampleRateHz)) ||
        (state && (state.sampleRate || state.sampleRateHz));
      if (sampleRate) facts.push(`${Number(sampleRate).toLocaleString()} Hz`);
      const rtf = engine && (engine.rtf || engine.realtimeFactor);
      if (rtf) facts.push(`RTF ${rtf}`);
      const latency = engine && (engine.firstAudioMs || engine.latencyMs);
      if (latency) facts.push(t("voice.latency", { value: latency }));
      const measured = engine && (engine.measurement || engine.measured);
      if (typeof measured === "string" && measured !== "") facts.push(measured);
      return facts;
    }

    function licenseHref(engine) {
      if (engine && typeof engine.licenseUrl === "string" && engine.licenseUrl !== "") {
        return engine.licenseUrl;
      }
      const license = String((engine && engine.license) || "").trim();
      const known = {
        MIT: "https://opensource.org/license/mit",
        "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
        "GPL-3.0": "https://www.gnu.org/licenses/gpl-3.0.html",
        "GPL-3.0-or-later": "https://www.gnu.org/licenses/gpl-3.0.html",
        "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
        "OpenRAIL-M": "https://huggingface.co/spaces/CompVis/stable-diffusion-license",
      };
      return known[license] || "";
    }

    function kindLabel(t, kind) {
      if (!kind) return t("tool.unknownKind");
      const key = `tool.kind.${kind}`;
      const value = t(key);
      return value === key ? t("tool.unknownKind") : value;
    }

    // MARK: - Settings: config draft
    //
    // The draft is deliberately separate from the polled state. A poll can land
    // between a keystroke and its debounce; merging every polled config wholesale
    // would revert the keystroke. `pendingRef` remembers which keys the user is
    // still editing, and the merge below never touches those.

    function useConfigDraft(config) {
      const [draft, setDraft] = React.useState(() =>
        Object.assign({}, FALLBACK_CONFIG, config || {}),
      );
      const [pendingKeys, setPendingKeys] = React.useState([]);
      const [saveState, setSaveState] = React.useState("idle");
      const [saveError, setSaveError] = React.useState(null);
      const pendingRef = React.useRef({});
      const queueRef = React.useRef({});
      const timerRef = React.useRef(null);
      const savedTimerRef = React.useRef(null);
      const serverSignatureRef = React.useRef(config ? JSON.stringify(config) : null);
      const mountedRef = React.useRef(true);
      const savingRef = React.useRef(false);
      const againRef = React.useRef(false);

      const flush = React.useCallback(async () => {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (savingRef.current) {
          // Serialize writes: two concurrent PATCHes can return out of order and
          // paint an older config over a newer one. The queued values are sent
          // as soon as the current request settles.
          againRef.current = true;
          return;
        }
        const patch = queueRef.current;
        queueRef.current = {};
        if (Object.keys(patch).length === 0) return;
        savingRef.current = true;
        setSaveState("saving");
        setSaveError(null);
        try {
          const response = await requestJson(ROUTES.config, {
            method: "POST",
            body: { patch },
          });
          if (response && response.ok === false) {
            throw new Error(errorText(response.error || "config rejected"));
          }
          if (response && response.state) store.applyServerState(response.state);
          for (const key of Object.keys(patch)) {
            // A newer edit of the same key is already queued; keep it pending.
            if (!Object.prototype.hasOwnProperty.call(queueRef.current, key)) {
              delete pendingRef.current[key];
            }
          }
          if (mountedRef.current) {
            setPendingKeys(Object.keys(pendingRef.current));
            setSaveState("saved");
            if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setSaveState("idle");
            }, SAVED_INDICATOR_MS);
          }
          store.pollNow();
        } catch (error) {
          // Put the unsent values back so nothing typed is lost; Retry re-sends them.
          queueRef.current = Object.assign({}, patch, queueRef.current);
          if (mountedRef.current) {
            setSaveState("error");
            setSaveError(errorText(error));
          }
        } finally {
          savingRef.current = false;
          if (againRef.current) {
            againRef.current = false;
            if (Object.keys(queueRef.current).length > 0) flush();
          }
        }
      }, []);

      React.useEffect(() => {
        if (!config) return;
        const signature = JSON.stringify(config);
        if (signature === serverSignatureRef.current) return;
        serverSignatureRef.current = signature;
        setDraft((previous) => {
          let next = null;
          for (const key of Object.keys(config)) {
            if (Object.prototype.hasOwnProperty.call(pendingRef.current, key)) continue;
            if (previous[key] !== config[key]) {
              if (next === null) next = Object.assign({}, previous);
              next[key] = config[key];
            }
          }
          return next === null ? previous : next;
        });
      }, [config]);

      React.useEffect(() => {
        return () => {
          mountedRef.current = false;
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
          // Unmounting mid-debounce should not silently discard a typed value.
          if (Object.keys(queueRef.current).length > 0) {
            requestJson(ROUTES.config, {
              method: "POST",
              body: { patch: queueRef.current },
              keepalive: true,
            }).catch(() => {});
          }
        };
      }, []);

      const update = React.useCallback(
        (patch, immediate) => {
          setDraft((previous) => Object.assign({}, previous, patch));
          Object.assign(pendingRef.current, patch);
          Object.assign(queueRef.current, patch);
          setPendingKeys(Object.keys(pendingRef.current));
          setSaveState("saving");
          setSaveError(null);
          if (immediate === true) {
            flush();
            return;
          }
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => flush(), CONFIG_DEBOUNCE_MS);
        },
        [flush],
      );

      const retry = React.useCallback(() => {
        queueRef.current = Object.assign({}, pendingRef.current, queueRef.current);
        flush();
      }, [flush]);

      return { draft, update, pendingKeys, saveState, saveError, retry };
    }

    // MARK: - Settings: engines, clones

    function EngineCard(props) {
      const { t, engine, setup, busy, onSetup } = props;
      const running = setup && setup.status === "running";
      const thisSetup = setup && setup.engine === engine.id ? setup : null;
      const href = licenseHref(engine);
      const license = engine.license || t("common.unknown");
      const status =
        engine.installed === true
          ? t("engines.installed")
          : engine.available === true
            ? t("engines.available")
            : t("engines.unavailable");

      return h(
        "article",
        { className: "ps-engine-card" },
        h(
          "div",
          { className: "ps-engine-head" },
          h("h3", { className: "ps-engine-title" }, engine.label || engine.id),
          h(
            "span",
            {
              className: "ps-status-dot",
              "data-ok": engine.available === true ? "1" : "0",
              title: status,
            },
            status,
          ),
        ),
        h(
          "p",
          { className: "ps-engine-line" },
          h("span", { className: "ps-engine-key" }, t("engines.license")),
          href
            ? h(
                "a",
                { className: "ps-link", href, target: "_blank", rel: "noopener noreferrer" },
                license,
              )
            : license,
        ),
        engine.sizeHint
          ? h(
              "p",
              { className: "ps-engine-line" },
              h("span", { className: "ps-engine-key" }, t("engines.size")),
              engine.sizeHint,
            )
          : null,
        engine.runtime
          ? h(
              "p",
              { className: "ps-engine-line ps-engine-runtime" },
              h("span", { className: "ps-engine-key" }, t("engines.runtime")),
              h("code", { className: "ps-code" }, engine.runtime),
            )
          : null,
        engine.reason
          ? h(
              "p",
              { className: "ps-engine-line ps-engine-reason" },
              h("span", { className: "ps-engine-key" }, t("engines.reason")),
              engine.reason,
            )
          : null,
        engine.notes
          ? h(
              "p",
              { className: "ps-engine-line ps-engine-notes" },
              h("span", { className: "ps-engine-key" }, t("engines.notes")),
              engine.notes,
            )
          : null,
        engine.id === "pocket"
          ? h("p", { className: "ps-engine-note" }, t("engines.pocketNote"))
          : null,
        engine.id === "say" || engine.personalOnly === true
          ? h("p", { className: "ps-engine-note ps-engine-warn" }, t("engines.sayNote"))
          : null,
        h(
          "div",
          { className: "ps-engine-actions" },
          h(
            "button",
            {
              type: "button",
              className: "ps-btn",
              disabled: busy === true || running === true,
              onClick: () => onSetup(engine.id),
            },
            running && thisSetup ? t("engines.installing") : engine.installed ? t("engines.repair") : t("engines.install"),
          ),
        ),
        thisSetup
          ? h(
              "div",
              { className: "ps-setup", "data-status": thisSetup.status },
              h(
                "p",
                { className: "ps-setup-line" },
                thisSetup.status === "running"
                  ? t("engines.setupRunning", {
                      time:
                        thisSetup.startedAt && Number.isFinite(Number(thisSetup.startedAt))
                          ? formatTime(thisSetup.startedAt)
                          : t("common.unknown"),
                    })
                  : thisSetup.status === "failed"
                    ? t("engines.setupFailed")
                    : t("engines.setupDone"),
              ),
              thisSetup.message
                ? h("p", { className: "ps-hint" }, thisSetup.message)
                : null,
            )
          : null,
      );
    }

    function CloneVoices(props) {
      const { t, voices, busy, error, onAdd, onRemove } = props;
      const [name, setName] = React.useState("");
      const [path, setPath] = React.useState("");
      const [rights, setRights] = React.useState(false);
      const [removing, setRemoving] = React.useState("");
      const list = Array.isArray(voices) ? voices : [];
      const pathAbsolute = path.trim().startsWith("/");
      const canAdd =
        rights === true &&
        name.trim() !== "" &&
        path.trim() !== "" &&
        pathAbsolute &&
        busy !== true;

      function submit(event) {
        if (event) event.preventDefault();
        if (!canAdd) return;
        Promise.resolve(onAdd(name.trim(), path.trim())).then((ok) => {
          if (ok) {
            setName("");
            setPath("");
            setRights(false);
          }
        });
      }

      return h(
        Section,
        { id: "ps-clones", title: t("clones.title") },
        h("p", { className: "ps-hint ps-intro" }, t("clones.intro")),
        h("p", { className: "ps-hint ps-intro" }, t("clones.note")),
        list.length === 0
          ? h("p", { className: "ps-empty" }, t("clones.empty"))
          : h(
              "ul",
              { className: "ps-clone-list" },
              list.map((voice) => {
                const key = voice.id || voice.name || voice.path;
                return h(
                  "li",
                  { className: "ps-clone-item", key },
                  h(
                    "div",
                    { className: "ps-clone-meta" },
                    h("span", { className: "ps-clone-name" }, voice.name || voice.id),
                    h(
                      "span",
                      { className: "ps-clone-sub" },
                      [
                        voice.engine ? `${t("clones.engine")}: ${voice.engine}` : "",
                        voice.path || "",
                        voice.createdAt
                          ? t("clones.createdAt", { date: formatDate(voice.createdAt) })
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "ps-btn ps-btn-danger",
                      disabled: removing !== "" || busy === true,
                      onClick: () => {
                        setRemoving(voice.name || voice.id);
                        Promise.resolve(onRemove(voice)).finally(() => setRemoving(""));
                      },
                    },
                    removing === (voice.name || voice.id)
                      ? t("clones.removing")
                      : t("clones.remove"),
                  ),
                );
              }),
            ),
        h(
          "form",
          { className: "ps-clone-form", onSubmit: submit },
          h(
            "div",
            { className: "ps-field" },
            h("label", { className: "ps-label", htmlFor: "ps-clone-name" }, t("clones.name")),
            h("input", {
              id: "ps-clone-name",
              className: "ps-input",
              type: "text",
              value: name,
              placeholder: t("clones.namePlaceholder"),
              onChange: (event) => setName(event.target.value),
            }),
          ),
          h(
            "div",
            { className: "ps-field" },
            h("label", { className: "ps-label", htmlFor: "ps-clone-path" }, t("clones.path")),
            h("input", {
              id: "ps-clone-path",
              className: "ps-input",
              type: "text",
              value: path,
              placeholder: t("clones.pathPlaceholder"),
              spellCheck: false,
              onChange: (event) => setPath(event.target.value),
            }),
            path !== "" && !pathAbsolute
              ? h("p", { className: "ps-hint ps-hint-error" }, t("clones.pathMustBeAbsolute"))
              : null,
          ),
          h(
            "label",
            { className: "ps-check", htmlFor: "ps-clone-rights" },
            h("input", {
              id: "ps-clone-rights",
              type: "checkbox",
              checked: rights,
              onChange: (event) => setRights(event.target.checked),
            }),
            h("span", null, t("clones.rights")),
          ),
          h(
            "div",
            { className: "ps-clone-submit" },
            h(
              "button",
              {
                type: "submit",
                className: "ps-btn ps-btn-primary",
                disabled: !canAdd,
              },
              t("clones.add"),
            ),
          ),
        ),
        rights === false && (name !== "" || path !== "")
          ? h("p", { className: "ps-hint" }, t("clones.rightsRequired"))
          : null,
        error ? h("p", { className: "ps-error" }, error) : null,
      );
    }

    // MARK: - Settings page

    function SettingsPage(ownerProps) {
      const t = useT();
      const app = useAppState();
      const state = app.state;
      const config = (state && state.config) || null;
      const draft = useConfigDraft(config);
      const cfg = draft.draft;
      const [busy, setBusy] = React.useState("");
      const [actionError, setActionError] = React.useState(null);

      const close = ownerProps && typeof ownerProps.close === "function" ? ownerProps.close : null;

      async function runAction(key, body) {
        setBusy(key);
        setActionError(null);
        const result = await callAction(body);
        setBusy("");
        if (!result || result.ok === false) {
          setActionError((result && result.error) || t("common.actionFailed"));
          return false;
        }
        store.pollNow();
        return true;
      }

      async function runSetup(engine) {
        setBusy(`setup:${engine}`);
        setActionError(null);
        const result = await callSetup(engine);
        setBusy("");
        if (!result || result.ok === false) {
          setActionError((result && result.error) || t("common.actionFailed"));
          return;
        }
        store.pollNow();
      }

      async function addVoice(name, path) {
        const ok = await runAction("clone:add", { action: "addVoice", name, path });
        return ok;
      }

      async function removeVoice(voice) {
        await runAction(`clone:${voice.name || voice.id}`, {
          action: "removeVoice",
          name: voice.name || voice.id,
        });
      }

      const head = h(
        "div",
        { className: "ps-page-head" },
        h(
          "div",
          null,
          h("h1", { className: "ps-title" }, t("page.title")),
          h("p", { className: "ps-sub" }, t("page.subtitle")),
        ),
        h(
          "div",
          { className: "ps-head-actions" },
          app.status === "offline"
            ? h("span", { className: "ps-chip-offline" }, t("page.offline"))
            : null,
          h(
            "span",
            {
              className: "ps-save",
              "data-state": draft.saveState,
              role: "status",
              "aria-live": "polite",
            },
            draft.saveState === "saving"
              ? t("common.saving")
              : draft.saveState === "saved"
                ? t("common.saved")
                : draft.saveState === "error"
                  ? t("common.saveError")
                  : "",
          ),
          draft.saveState === "error"
            ? h(
                "button",
                { type: "button", className: "ps-btn ps-btn-small", onClick: draft.retry },
                t("common.retry"),
              )
            : null,
          close
            ? h(
                "button",
                { type: "button", className: "ps-btn", onClick: close },
                t("page.close"),
              )
            : null,
        ),
      );

      if (!state) {
        return h(
          "div",
          { className: "ps-page" },
          head,
          h(
            "div",
            { className: "ps-section" },
            h(
              "p",
              { className: "ps-hint" },
              app.status === "offline" ? t("page.offlineHint") : t("page.loading"),
            ),
            app.status === "offline" && app.error
              ? h("p", { className: "ps-error" }, app.error)
              : null,
            h(
              "button",
              {
                type: "button",
                className: "ps-btn",
                onClick: () => store.pollNow(),
              },
              t("page.retry"),
            ),
          ),
        );
      }

      const engines = Array.isArray(state.engines) ? state.engines : [];
      const allVoices = Array.isArray(state.voices) ? state.voices : [];
      const clones = Array.isArray(cfg.voices) ? cfg.voices : [];
      const outputLabel =
        state.output === "browser" ? t("status.output.browser") : t("status.output.system");
      const usedEngine = resolvedEngine(state);
      const engineInUse =
        cfg.engine && cfg.engine !== "auto"
          ? usedEngine
            ? usedEngine.label || usedEngine.id
            : cfg.engine
          : usedEngine
            ? t("status.engineAuto", { engine: usedEngine.label || usedEngine.id })
            : t("voice.engineAuto");
      const queue = Array.isArray(state.queue) ? state.queue : [];
      const stateError = statusErrorMessage(state.error);

      const engineFilter = cfg.engine === "auto" ? null : cfg.engine;
      const voiceOptions = [];
      const seenVoices = new Set();
      for (const voice of allVoices) {
        if (engineFilter && voice.engine !== engineFilter) continue;
        if (voice.language && cfg.language && voice.language !== cfg.language) continue;
        const id = String(voice.id);
        if (seenVoices.has(id)) continue;
        seenVoices.add(id);
        voiceOptions.push({
          value: id,
          label: `${voice.label || voice.id}${voice.engine ? ` · ${voice.engine}` : ""}`,
        });
      }
      for (const voice of clones) {
        const id = String(voice.name || voice.id || "");
        if (id === "" || seenVoices.has(id)) continue;
        if (engineFilter && voice.engine && voice.engine !== engineFilter) continue;
        seenVoices.add(id);
        voiceOptions.push({
          value: id,
          label: `${id} · ${t("voice.cloneSuffix")}`,
        });
      }
      if (cfg.voice && !seenVoices.has(String(cfg.voice))) {
        voiceOptions.unshift({ value: String(cfg.voice), label: String(cfg.voice) });
      }
      if (voiceOptions.length === 0) {
        voiceOptions.push({ value: cfg.voice || "", label: cfg.voice || t("common.none") });
      }

      const engineOptions = [
        { value: "auto", label: t("voice.engineAuto") },
        ...engines.map((engine) => ({
          value: engine.id,
          label: `${engine.label || engine.id} — ${
            engine.installed === true
              ? t("engines.installed")
              : engine.available === true
                ? t("engines.available")
                : t("engines.unavailable")
          }`,
        })),
      ];
      if (!engineOptions.some((option) => option.value === cfg.engine)) {
        engineOptions.push({ value: cfg.engine, label: String(cfg.engine) });
      }

      const facts = measurementFacts(t, state);
      const setup = state.setup || null;
      const saveIndicatorError = draft.saveError;

      return h(
        "div",
        { className: "ps-page" },
        head,
        actionError
          ? h("p", { className: "ps-error ps-page-error", role: "alert" }, actionError)
          : null,
        saveIndicatorError
          ? h("p", { className: "ps-error ps-page-error", role: "alert" }, saveIndicatorError)
          : null,

        h(
          Section,
          { id: "ps-status", title: t("status.title") },
          h(Toggle, {
            id: "ps-enabled",
            label: t("status.enabled"),
            hint: t("status.enabledHint"),
            checked: cfg.enabled === true,
            onChange: (value) => draft.update({ enabled: value }, true),
          }),
          h(
            Row,
            { label: t("status.output") },
            h("span", { className: "ps-value" }, outputLabel),
          ),
          h(
            Row,
            { label: t("status.engine") },
            h("span", { className: "ps-value" }, engineInUse),
          ),
          h(
            Row,
            { label: t("status.queue") },
            h("span", { className: "ps-value" }, String(queue.length)),
          ),
          h(
            Row,
            { label: t("status.lastError") },
            h(
              "span",
              { className: "ps-value", "data-error": stateError ? "1" : "0" },
              stateError || t("status.noError"),
            ),
          ),
          h(
            "div",
            { className: "ps-actions" },
            h(
              "button",
              {
                type: "button",
                className: "ps-btn",
                disabled: busy === "test",
                onClick: () => runAction("test", { action: "test" }),
              },
              busy === "test" ? t("common.working") : t("status.test"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "ps-btn",
                disabled: busy === "stop",
                onClick: () => {
                  player.stop();
                  setBusy("stop");
                  setTimeout(() => setBusy(""), 400);
                },
              },
              t("status.stop"),
            ),
            h(
              "span",
              { className: "ps-version" },
              t("status.version", { version: state.pluginVersion || "?" }),
            ),
          ),
        ),

        h(
          Section,
          { id: "ps-voice", title: t("voice.title") },
          h(
            Row,
            { label: t("voice.engine"), labelId: "ps-engine-label" },
            h(Select, {
              id: "ps-engine",
              labelId: "ps-engine-label",
              value: cfg.engine || "auto",
              options: engineOptions,
              onChange: (value) => draft.update({ engine: value }, true),
            }),
          ),
          h(
            Row,
            { label: t("voice.voice"), labelId: "ps-voice-label" },
            h(Select, {
              id: "ps-voice-select",
              labelId: "ps-voice-label",
              value: cfg.voice || "",
              options: voiceOptions,
              onChange: (value) => draft.update({ voice: value }, true),
            }),
          ),
          h(
            Row,
            { label: t("voice.language"), labelId: "ps-language-label" },
            h(Select, {
              id: "ps-language",
              labelId: "ps-language-label",
              value: cfg.language || "cs",
              options: [
                { value: "cs", label: t("voice.language.cs") },
                { value: "en", label: t("voice.language.en") },
              ],
              onChange: (value) => draft.update({ language: value }, true),
            }),
          ),
          h(
            Row,
            { label: t("voice.speed") },
            h(RangeField, {
              id: "ps-speed",
              label: t("voice.speed"),
              value: clampNumber(cfg.speed, SPEED_MIN, SPEED_MAX, 1),
              min: SPEED_MIN,
              max: SPEED_MAX,
              step: 0.05,
              format: (value) => `${Number(value).toFixed(2).replace(/0$/, "")}×`,
              onChange: (value) => draft.update({ speed: value }, false),
            }),
          ),
          h(
            Row,
            { label: t("voice.volume") },
            h(RangeField, {
              id: "ps-volume",
              label: t("voice.volume"),
              value: clampNumber(cfg.volume, 0, 1, 1),
              min: 0,
              max: 1,
              step: 0.05,
              format: (value) => t("common.percent", { value: Math.round(Number(value) * 100) }),
              onChange: (value) => draft.update({ volume: value }, false),
            }),
          ),
          facts.length > 0
            ? h(
                Row,
                { label: t("voice.measurement") },
                h("span", { className: "ps-value ps-measure" }, facts.join(" · ")),
              )
            : null,
          voiceOptions.length <= 1 && allVoices.length === 0
            ? h("p", { className: "ps-hint" }, t("voice.noVoices"))
            : null,
        ),

        h(
          Section,
          { id: "ps-reading", title: t("reading.title") },
          h(Toggle, {
            id: "ps-auto-summary",
            label: t("reading.autoSummary"),
            hint: t("reading.autoSummaryHint"),
            checked: cfg.autoSummary === true,
            onChange: (value) => draft.update({ autoSummary: value }, true),
          }),
          h(
            Row,
            { label: t("reading.maxChars"), labelId: "ps-max-chars-label" },
            h(NumberField, {
              id: "ps-max-chars",
              labelId: "ps-max-chars-label",
              value: clampNumber(cfg.maxChars, MAX_CHARS_MIN, MAX_CHARS_MAX, 300),
              min: MAX_CHARS_MIN,
              max: MAX_CHARS_MAX,
              step: 50,
              onCommit: (value) => draft.update({ maxChars: value }, false),
            }),
          ),
          h("p", { className: "ps-hint ps-row-after" }, t("reading.maxCharsHint")),
          h(
            Row,
            { label: t("reading.repeat"), labelId: "ps-repeat-label" },
            h(Select, {
              id: "ps-repeat",
              labelId: "ps-repeat-label",
              value: String(cfg.attentionRepeatSec || 0),
              options: [0, 15, 30, 60].map((value) => ({
                value: String(value),
                label:
                  value === 0
                    ? t("reading.repeat.once")
                    : t("reading.repeat.every", { value }),
              })),
              onChange: (value) => draft.update({ attentionRepeatSec: Number(value) }, true),
            }),
          ),
          h(Toggle, {
            id: "ps-notify",
            label: t("reading.notify"),
            hint: t("reading.notifyHint"),
            checked: cfg.notify === true,
            onChange: (value) => draft.update({ notify: value }, true),
          }),
          h(Toggle, {
            id: "ps-system-playback",
            label: t("reading.systemPlayback"),
            hint: t("reading.systemPlaybackHint"),
            checked: cfg.systemPlayback === true,
            onChange: (value) => draft.update({ systemPlayback: value }, true),
          }),
          h(
            "div",
            { className: "ps-row" },
            h(
              "div",
              { className: "ps-row-label" },
              h("span", { className: "ps-label" }, t("reading.dnd")),
              h("p", { className: "ps-hint" }, t("reading.dndHint")),
            ),
            h(
              "div",
              { className: "ps-row-control" },
              h("label", { className: "ps-inline-label", htmlFor: "ps-dnd-from" }, t("reading.dndFrom")),
              h(TimeField, {
                id: "ps-dnd-from",
                value: cfg.dndFrom,
                onChange: (value) => draft.update({ dndFrom: value }, false),
              }),
              h("label", { className: "ps-inline-label", htmlFor: "ps-dnd-to" }, t("reading.dndTo")),
              h(TimeField, {
                id: "ps-dnd-to",
                value: cfg.dndTo,
                onChange: (value) => draft.update({ dndTo: value }, false),
              }),
            ),
          ),
        ),

        h(
          Section,
          { id: "ps-privacy", title: t("privacy.title") },
          h(Toggle, {
            id: "ps-commercial",
            label: t("privacy.commercial"),
            hint: t("privacy.commercialHint"),
            checked: cfg.commercialMode === true,
            onChange: (value) => draft.update({ commercialMode: value }, true),
          }),
          h(Toggle, {
            id: "ps-personal",
            label: t("privacy.allowPersonal"),
            hint: t("privacy.allowPersonalWarning"),
            checked: cfg.allowPersonalVoice === true,
            onChange: (value) => draft.update({ allowPersonalVoice: value }, true),
          }),
          h(
            "div",
            { className: "ps-note" },
            h("p", { className: "ps-note-title" }, t("privacy.local")),
            h("p", { className: "ps-hint" }, t("privacy.localHint")),
          ),
        ),

        h(
          Section,
          { id: "ps-engines", title: t("engines.title") },
          engines.length === 0
            ? h("p", { className: "ps-hint" }, t("engines.none"))
            : h(
                "div",
                { className: "ps-engine-grid" },
                engines.map((engine) =>
                  h(EngineCard, {
                    key: engine.id,
                    t,
                    engine,
                    setup,
                    busy: busy.startsWith("setup:"),
                    onSetup: runSetup,
                  }),
                ),
              ),
        ),

        h(CloneVoices, {
          t,
          voices: clones,
          busy: busy.startsWith("clone:"),
          error: actionError,
          onAdd: addVoice,
          onRemove: removeVoice,
        }),
      );
    }

    // MARK: - Overlay

    function MiniPlayer() {
      const t = useT();
      const app = useAppState();
      const playback = usePlayer();
      const state = app.state;
      const current = state && state.current ? state.current : null;
      const attention = state && state.attention ? state.attention : null;
      const attentionId = attention && attention.id ? String(attention.id) : null;
      const [dismissed, setDismissed] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        if (attentionId === null) {
          setDismissed(null);
          return undefined;
        }
        const onKey = (event) => {
          if (event.key === "Escape") setDismissed(attentionId);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [attentionId]);

      const showAttention =
        attention !== null &&
        attention.acknowledged !== true &&
        dismissed !== attentionId;
      if (!current && !showAttention) return null;

      async function acknowledge() {
        if (!attention) return;
        setBusy(true);
        setError(null);
        const result = await callAction({ action: "ack", id: attention.id });
        setBusy(false);
        if (!result || result.ok === false) {
          setError((result && result.error) || t("common.actionFailed"));
          return;
        }
        setDismissed(attentionId);
        store.pollNow();
      }

      const queue = state && Array.isArray(state.queue) ? state.queue : [];
      const isSystem = current && current.owner === "system";
      const segments = current && Array.isArray(current.segments) ? current.segments : [];
      const localIndex = playback.index || 0;
      const playingThis = current && playback.jobId === current.id;
      // After the last delivered segment ends, the Host may still be synthesizing
      // the next one. Show "preparing" instead of a misleading Play button.
      const awaitingMore =
        current &&
        current.complete !== true &&
        playingThis === true &&
        segments.length > 0 &&
        playback.index + 1 >= segments.length &&
        playback.playing !== true &&
        playback.paused !== true &&
        playback.blocked !== true &&
        playback.stopped !== true;
      const pending =
        current && (!playingThis || playback.pending || segments.length === 0 || awaitingMore);

      let playerControls = null;
      if (current) {
        if (isSystem) {
          playerControls = h(
            "button",
            {
              type: "button",
              className: "ps-btn ps-btn-small",
              onClick: () => player.stop(),
            },
            t("common.stop"),
          );
        } else if (playback.blocked === true || playback.paused === true) {
          playerControls = h(
            "span",
            { className: "ps-controls" },
            h(
              "button",
              {
                type: "button",
                className: "ps-btn ps-btn-small ps-btn-primary",
                onClick: () => player.userPlay(),
              },
              playback.paused === true ? t("common.resume") : t("common.play"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "ps-btn ps-btn-small",
                onClick: () => player.stop(),
              },
              t("common.stop"),
            ),
          );
        } else if (playback.playing === true) {
          playerControls = h(
            "span",
            { className: "ps-controls" },
            h(
              "button",
              {
                type: "button",
                className: "ps-btn ps-btn-small",
                onClick: () => player.pause(),
              },
              t("common.pause"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "ps-btn ps-btn-small",
                onClick: () => player.stop(),
              },
              t("common.stop"),
            ),
          );
        } else if (playback.stopped === true) {
          playerControls = h("span", { className: "ps-owner" }, t("overlay.stopped"));
        } else if (playback.done === true) {
          playerControls = h("span", { className: "ps-owner" }, t("overlay.done"));
        } else {
          playerControls = h(
            "button",
            {
              type: "button",
              className: "ps-btn ps-btn-small",
              onClick: () => player.userPlay(),
            },
            t("common.play"),
          );
        }
      }

      return h(
        "div",
        { className: "ps-overlay", style: { pointerEvents: "auto" } },
        showAttention
          ? h(
              "section",
              { className: "ps-banner", role: "status", "aria-live": "polite" },
              h(
                "div",
                { className: "ps-banner-head" },
                h("strong", { className: "ps-banner-title" }, t("overlay.attentionTitle")),
                h(
                  "button",
                  {
                    type: "button",
                    className: "ps-icon-btn",
                    "aria-label": t("common.dismiss"),
                    onClick: () => setDismissed(attentionId),
                  },
                  "✕",
                ),
              ),
              h(
                "p",
                { className: "ps-banner-text ps-clamp-3" },
                attention.text || "",
              ),
              h(
                "p",
                { className: "ps-hint ps-banner-hint" },
                attention.repeatEverySec > 0
                  ? t("overlay.attentionRepeat", { value: attention.repeatEverySec })
                  : t("overlay.attentionHint"),
              ),
              h(
                "div",
                { className: "ps-banner-actions" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "ps-btn ps-btn-primary",
                    disabled: busy,
                    onClick: acknowledge,
                  },
                  t("overlay.ack"),
                ),
              ),
              error
                ? h(
                    "p",
                    { className: "ps-error ps-small" },
                    t("overlay.actionFailed", { error }),
                  )
                : null,
            )
          : null,
        current
          ? h(
              "section",
              { className: "ps-panel" },
              h(
                "div",
                { className: "ps-panel-head" },
                h(
                  "strong",
                  { className: "ps-panel-title" },
                  isSystem ? t("overlay.systemTitle") : t("overlay.playerTitle"),
                ),
                queue.length > 0
                  ? h(
                      "span",
                      { className: "ps-owner" },
                      t("overlay.queue", { count: queue.length }),
                    )
                  : null,
              ),
              h(
                "p",
                { className: "ps-panel-text ps-clamp-2" },
                current.text || "",
              ),
              isSystem
                ? h("p", { className: "ps-hint" }, t("overlay.systemHint"))
                : null,
              pending
                ? h("p", { className: "ps-hint" }, t("overlay.preparing"))
                : null,
              playback.blocked === true
                ? h("p", { className: "ps-hint ps-warn" }, t("overlay.blocked"))
                : null,
              !isSystem && segments.length > 0
                ? h(
                    "div",
                    { className: "ps-panel-foot" },
                    h(
                      "span",
                      { className: "ps-owner" },
                      `${Math.min(localIndex + 1, segments.length)} / ${segments.length}`,
                    ),
                    playerControls,
                  )
                : h(
                    "div",
                    { className: "ps-panel-foot" },
                    h("span", { className: "ps-owner" }),
                    playerControls,
                  ),
            )
          : null,
      );
    }

    // MARK: - Tool card
    //
    // The Host returns a JSON string inside a ToolResultNode. Parsing is total:
    // a malformed result still renders the raw text instead of throwing inside
    // the conversation tree.

    function toolResultText(block) {
      if (!block) return "";
      const content = block.content;
      if (Array.isArray(content)) {
        return content
          .filter((part) => part && part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
      }
      if (typeof block.text === "string") return block.text;
      return "";
    }

    function parseToolRow(block) {
      const raw = toolResultText(block);
      if (raw === "") return { raw: "", data: null };
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          if (parsed.result && typeof parsed.result === "object") {
            return { raw, data: Object.assign({}, parsed.result, { ok: parsed.ok }) };
          }
          return { raw, data: parsed };
        }
        return { raw, data: null };
      } catch {
        return { raw, data: null };
      }
    }

    function ToolCard(props) {
      const t = useT();
      const phase = props && props.phase;
      const block = props && props.block;
      const parsed = React.useMemo(() => parseToolRow(block), [block]);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      if (phase !== "result") {
        return h(
          "div",
          { className: "ps-tool ps-tool-skeleton" },
          h(
            "span",
            { className: "ps-tool-skeleton-text" },
            phase === "start" ? t("tool.starting") : t("tool.preparing"),
          ),
        );
      }

      const data = parsed.data;
      const failed = data && data.ok === false;
      const text = (data && typeof data.text === "string" && data.text) || "";
      const duration =
        data && (data.ms || data.durationMs)
          ? secondsLabel(t, (Number(data.ms || data.durationMs) / 1000).toFixed(1))
          : "";
      const segmentCount =
        data && (typeof data.segments === "number" || typeof data.segments === "string")
          ? String(data.segments)
          : "";
      const id = data && data.id ? data.id : null;

      async function replay() {
        setBusy(true);
        setError(null);
        let result = await callAction({ action: "replay", id });
        if (
          result &&
          result.ok === false &&
          /unknown\s+action/i.test(String(result.error || ""))
        ) {
          // Older hosts only know `speak`; the explicit text keeps the replay
          // independent of whatever is in `last`.
          result = await callAction({
            action: "speak",
            text,
            kind: "manual",
          });
        }
        setBusy(false);
        if (!result || result.ok === false) {
          setError((result && result.error) || t("common.actionFailed"));
          return;
        }
        store.pollNow();
      }

      return h(
        "div",
        { className: "ps-tool", "data-error": failed ? "1" : "0" },
        h(
          "div",
          { className: "ps-tool-head" },
          h("span", { className: "ps-badge" }, kindLabel(t, data && data.kind)),
          data && data.engine
            ? h("span", { className: "ps-chip" }, `${t("tool.engine")}: ${data.engine}`)
            : null,
          data && data.voice
            ? h("span", { className: "ps-chip" }, `${t("tool.voice")}: ${data.voice}`)
            : null,
          segmentCount
            ? h(
                "span",
                { className: "ps-chip" },
                `${t("tool.segments")}: ${segmentCount}`,
              )
            : null,
          duration
            ? h("span", { className: "ps-chip" }, `${t("tool.duration")}: ${duration}`)
            : null,
        ),
        text
          ? h("p", { className: "ps-tool-text ps-clamp-2" }, text)
          : h(
              "p",
              { className: "ps-tool-text ps-clamp-2" },
              parsed.raw || t("tool.noText"),
            ),
        failed
          ? h(
              "p",
              { className: "ps-error ps-small" },
              t("tool.error", { error: errorText(data.error || data.message || "error") }),
            )
          : null,
        id
          ? h(
              "div",
              { className: "ps-tool-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "ps-btn ps-btn-small",
                  disabled: busy,
                  onClick: (event) => {
                    // The conversation row may expand on click; the button owns
                    // its own gesture.
                    if (event && typeof event.stopPropagation === "function") {
                      event.stopPropagation();
                    }
                    replay();
                  },
                },
                busy ? t("tool.replaying") : t("tool.replay"),
              ),
            )
          : null,
        error
          ? h(
              "p",
              { className: "ps-error ps-small" },
              t("tool.replayFailed", { error }),
            )
          : null,
      );
    }

    // MARK: - Styles
    //
    // Every colour is a theme alias with an inherit/currentColor fallback. The
    // overlay pins a width so a longer summary cannot push the page around.

    const CSS = `
.ps-page{max-width:860px;margin:0 auto;padding:20px 24px 48px;display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:13px;line-height:1.5}
.ps-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ps-title{margin:0;font-size:20px;line-height:1.25;font-weight:650;color:var(--dsw-alias-label-primary,inherit)}
.ps-sub{margin:4px 0 0;max-width:62ch;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.ps-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ps-head-actions:empty{display:none}
.ps-chip-offline{border:.5px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-state-warn-primary,inherit)}
.ps-save{min-height:16px;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-save[data-state=error]{color:var(--dsw-alias-state-error-primary,inherit)}
.ps-section{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,transparent));border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1,currentColor));border-radius:var(--dsw-radius-lg,16px);padding:14px 16px;display:flex;flex-direction:column;gap:2px}
.ps-section-title{margin:0 0 4px;font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,inherit)}
.ps-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l1,transparent)}
.ps-section>.ps-row:first-of-type{border-top:none}
.ps-row-label{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:2px}
.ps-row-control{flex:0 0 auto;max-width:56%;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.ps-row-after{margin:-6px 0 6px}
.ps-label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.ps-hint{margin:0;max-width:56ch;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-hint-error{color:var(--dsw-alias-state-error-primary,inherit)}
.ps-intro{margin-bottom:4px}
.ps-empty{margin:6px 0;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-value{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums}
.ps-value[data-error="1"]{color:var(--dsw-alias-state-error-primary,inherit)}
.ps-measure{max-width:34ch;text-align:right}
.ps-toggle{padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l1,transparent)}
.ps-section>.ps-toggle:first-of-type{border-top:none}
.ps-toggle-label{display:flex;align-items:flex-start;gap:9px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.ps-toggle-label input[type=checkbox]{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,currentColor);width:15px;height:15px;flex:none}
.ps-toggle-text{min-width:0}
.ps-toggle-hint{margin:2px 0 0 24px}
.ps-select,.ps-input{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-base,transparent);border:.5px solid var(--dsw-alias-border-l3,currentColor);border-radius:var(--dsw-radius-sm,8px);padding:5px 8px;min-height:30px}
.ps-select{max-width:280px}
.ps-input-number{width:96px}
.ps-input-time{width:104px}
.ps-range-wrap{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.ps-range{width:190px;accent-color:var(--dsw-alias-brand-primary,currentColor)}
.ps-inline-label{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px}
.ps-version{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-btn{font-family:inherit;font-size:12px;line-height:16px;padding:5px 11px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,currentColor);background:var(--dsw-alias-interactive-bg-hover-solid,transparent);color:var(--dsw-alias-label-primary,inherit);cursor:pointer}
.ps-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover-solid,transparent))}
.ps-btn:focus-visible,.ps-input:focus-visible,.ps-select:focus-visible,.ps-range:focus-visible,.ps-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:2px}
.ps-btn:disabled{opacity:.5;cursor:default}
.ps-btn-small{font-size:11px;padding:3px 9px}
.ps-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,currentColor));color:var(--dsw-alias-label-primary-foreground,inherit);border-color:transparent}
.ps-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,currentColor))}
.ps-btn-danger{color:var(--dsw-alias-state-error-primary,inherit)}
.ps-error{margin:4px 0 0;font-size:11px;line-height:1.45;color:var(--dsw-alias-state-error-primary,inherit);overflow-wrap:anywhere}
.ps-page-error{padding:8px 10px;border:.5px solid var(--dsw-alias-state-error-secondary,currentColor);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.ps-note{margin-top:8px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,transparent)}
.ps-note-title{margin:0 0 2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.ps-engine-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:6px}
.ps-engine-card{border:.5px solid var(--dsw-alias-border-l2,currentColor);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,transparent);padding:12px;display:flex;flex-direction:column;gap:5px;min-width:0}
.ps-engine-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.ps-engine-title{margin:0;font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,inherit)}
.ps-status-dot{font-size:10px;color:var(--dsw-alias-state-error-primary,inherit);flex:none}
.ps-status-dot[data-ok="1"]{color:var(--dsw-alias-state-success-primary,inherit)}
.ps-engine-line{margin:0;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.ps-engine-key{display:inline-block;min-width:46px;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-engine-reason{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary,inherit))}
.ps-engine-notes{color:var(--dsw-alias-label-tertiary,inherit)}
.ps-engine-note{margin:2px 0 0;font-size:10px;line-height:1.45;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-engine-warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary,inherit))}
.ps-engine-actions{display:flex;justify-content:flex-end;margin-top:2px}
.ps-engine-runtime{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ps-code{font-family:var(--dsw-font-markdown-code-block-font-family,ui-monospace,monospace);font-size:10px}
.ps-link{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary,currentColor));text-decoration:underline;text-underline-offset:2px}
.ps-setup{margin-top:4px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l1,transparent)}
.ps-setup-line{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}
.ps-setup[data-status=failed] .ps-setup-line{color:var(--dsw-alias-state-error-primary,inherit)}
.ps-setup[data-status=done] .ps-setup-line{color:var(--dsw-alias-state-success-primary,inherit)}
.ps-clone-list{list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:6px}
.ps-clone-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1,transparent);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.ps-clone-meta{min-width:0;display:flex;flex-direction:column;gap:1px}
.ps-clone-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-clone-sub{font-size:10px;color:var(--dsw-alias-label-tertiary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52ch}
.ps-clone-form{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1,transparent)}
.ps-field{display:flex;flex-direction:column;gap:3px}
.ps-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer}
.ps-check input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,currentColor)}
.ps-clone-submit{display:flex;justify-content:flex-end}
.ps-overlay{position:fixed;right:20px;bottom:20px;z-index:90;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(380px,calc(100vw - 40px));font-family:inherit;font-size:13px;line-height:1.45}
.ps-panel,.ps-banner{box-sizing:border-box;width:340px;max-width:calc(100vw - 40px);min-width:280px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,Canvas));border:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,currentColor));border-radius:var(--dsw-radius-lg,16px);box-shadow:0 8px 28px var(--dsw-alias-bg-mask-2,rgba(20,20,24,.18));color:var(--dsw-alias-label-primary,inherit);padding:12px 14px}
.ps-panel{min-height:86px}
.ps-banner{border-color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-border-l3,currentColor));background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,Canvas))}
.ps-banner-head,.ps-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ps-banner-title{font-size:13px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-primary,inherit))}
.ps-panel-title{font-size:12px;color:var(--dsw-alias-label-primary,inherit)}
.ps-banner-text,.ps-panel-text{margin:5px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.ps-banner-hint{margin-top:4px}
.ps-banner-actions{display:flex;justify-content:flex-end;margin-top:8px}
.ps-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;min-height:24px}
.ps-owner{font-size:10px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums}
.ps-controls{display:flex;align-items:center;gap:6px}
.ps-icon-btn{font:inherit;font-size:13px;line-height:18px;width:24px;height:24px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;flex:none}
.ps-icon-btn:hover{background:var(--dsw-alias-interactive-bg-active,transparent);color:var(--dsw-alias-label-primary,inherit)}
.ps-warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary,inherit))}
.ps-small{margin:6px 0 0}
.ps-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ps-clamp-3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ps-tool{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1,currentColor);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2,transparent));padding:9px 12px;margin:4px 0 4px 4px;display:flex;flex-direction:column;gap:5px;min-height:54px;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.ps-tool[data-error="1"]{border-color:var(--dsw-alias-state-error-secondary,currentColor)}
.ps-tool-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:18px}
.ps-badge{border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;background:var(--dsw-alias-interactive-bg-active,transparent);color:var(--dsw-alias-label-primary,inherit)}
.ps-chip{font-size:10px;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-tool-text{margin:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.ps-tool-actions{display:flex;justify-content:flex-end}
.ps-tool-skeleton{justify-content:center}
.ps-tool-skeleton-text{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
@media (max-width:640px){.ps-page{padding:16px}.ps-row{flex-direction:column;gap:6px}.ps-row-control{max-width:100%;justify-content:flex-start}.ps-range{width:160px}}
`;

    function installStyles(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined") return () => {};
        const tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, "phononspeak: styles");
    }

    // MARK: - Apply

    const inject = ["slots", "locale", "connection"];

    function apply(ctx) {
      const connection =
        ctx && ctx.connection !== undefined ? ctx.connection : ctx && typeof ctx.get === "function" ? ctx.get("connection") : null;
      if (connection && connection.rpc && typeof connection.rpc.call === "function") {
        rpcFactory = (method, args) =>
          connection.rpc
            .call("/api", "phononspeak/" + method, { args: { request: args === undefined ? null : args } })
            .then(unwrapEnvelope);
      } else if (typeof console !== "undefined" && console && typeof console.warn === "function") {
        console.warn("Phononspeak: the connection service is unavailable; the UI will run in offline mode.");
      }
      installStyles(ctx);

      const locale = ctx.locale;
      if (locale && typeof locale.register === "function") {
        localeRef.current = locale;
        ctx.effect(() => {
          // Both languages are registered so switching the Harness language
          // re-renders this module's text from the same key set.
          const disposeEnglish = locale.register(NS, "en", DICTS.en);
          const disposeCzech = locale.register(NS, "cs", DICTS.cs);
          return () => {
            disposeEnglish();
            disposeCzech();
          };
        }, "phononspeak: dictionaries");
      }

      const t = locale && typeof locale.bind === "function" ? locale.bind(NS) : fallbackT;

      ctx.effect(() => {
        store.start();
        return () => store.stop();
      }, "phononspeak: state polling");

      // The first gesture anywhere unlocks audio for the whole session; a voice
      // plugin must not wait for the user to find its own play button.
      ctx.effect(() => {
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => {};
        const unlock = () => player.unlock();
        const events = ["pointerdown", "keydown", "touchstart"];
        for (const name of events) document.addEventListener(name, unlock, { passive: true });
        return () => {
          for (const name of events) document.removeEventListener(name, unlock);
        };
      }, "phononspeak: audio unlock");

      // Each registration waits for its slot declaration, because this plugin
      // loads `immediately` and the settings/conversation surfaces may declare
      // their slots later. Nothing outside these three slots is touched.
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "phononspeak",
                order: 55,
                locale: NS,
                label: () => t("settings.title"),
              },
              SettingsPage,
            ),
          ),
        "phononspeak: settings section",
      );

      ctx.effect(
        () =>
          ctx.slots.inject("shell.overlay", () =>
            ctx.slots.register(
              {
                name: "shell.overlay",
                id: "phononspeak-player",
                order: 90,
                locale: NS,
                label: () => "Phononspeak",
              },
              MiniPlayer,
            ),
          ),
        "phononspeak: overlay player",
      );

      ctx.effect(
        () =>
          ctx.slots.inject("tool.call.toolview", () =>
            ctx.slots.register(
              {
                name: "tool.call.toolview",
                key: "dsh_phononspeak",
                locale: NS,
              },
              ToolCard,
            ),
          ),
        "phononspeak: tool card",
      );
    }

    return { inject, apply };
  },
});
