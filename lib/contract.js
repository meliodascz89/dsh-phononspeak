//
//  contract.js — the one place that names the plugin's public surface.
//
//  WHY: the Host half, the Web client and the documentation must agree on the
//  HTTP paths, the state shape and the defaults. When they drift, the UI simply
//  stops showing anything and every symptom looks like a different bug, so the
//  names live here and everything else imports them.
//
//  The Web client cannot import this file (it is loaded as a separate browser
//  module with no bundler), so it repeats the route table literally. Keep the
//  two in sync; `test/contract.test.mjs` checks that the client's literals match.
//

/** Package name. Must equal `package.json.name` and the client module id. */
export const PLUGIN = "dsh-phononspeak";

/** Package version, mirrored in the state payload so the UI can show drift. */
export const VERSION = "0.1.0";

/** Every route the Host registers, all under one prefix. */
export const ROUTE_PREFIX = "/dsh-phononspeak/";

/** Node http paths used by the Web client and by curl in the docs. */
export const ROUTES = Object.freeze({
  /** GET — the whole UI state (queue, current job, attention, engines, voices, config). */
  state: "/dsh-phononspeak/state",
  /** POST {patch} — change settings, returns the fresh state. */
  config: "/dsh-phononspeak/config",
  /** POST {action, ...} — speak / summary / attention / stop / test / ack / … */
  action: "/dsh-phononspeak/action",
  /** POST {visible} — the browser reports focus/visibility so the Host can pick an output. */
  presence: "/dsh-phononspeak/presence",
  /** POST {engine} — provision an engine (venv, model download), GET — progress. */
  setup: "/dsh-phononspeak/setup",
  /** GET — `audio/<id>.wav`, one segment of one job, Range-capable. */
  audio: "/dsh-phononspeak/audio/",
});

/**
 * Queue priorities. Lower number speaks first. Attention always wins, because
 * "the agent needs a decision" is the only message that is useless late.
 */
export const PRIORITY = Object.freeze({
  attention: 0,
  question: 1,
  summary: 2,
  manual: 3,
  test: 4,
});

/** Spoken job kinds, used for priority, UI copy and the prompt. */
export const KINDS = Object.freeze(["attention", "question", "summary", "manual", "test"]);

/** Engine ids in the order the `auto` chain tries them. */
export const AUTO_CHAIN = Object.freeze(["supertonic", "piper", "pocket", "say"]);

/** Every engine the plugin knows, including ones this machine cannot run. */
export const ENGINE_IDS = Object.freeze(["supertonic", "piper", "pocket", "say"]);

/**
 * User settings. These are the values the dedicated settings page edits and the
 * Host persists to `<dataDir>/settings.json`; the Cordis `Config` only carries
 * infrastructure (paths, auto-provisioning) so the two never fight.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  engine: "auto",
  voice: "M1",
  language: "cs",
  speed: 1.0,
  volume: 1.0,
  /** Read a summary after every answer — opt-in; the model is told when it is on. */
  autoSummary: false,
  /** Repeat an attention call every N seconds until acknowledged; 0 = once. */
  attentionRepeatSec: 0,
  /** Play through `afplay` when no visible browser tab can play. */
  systemPlayback: true,
  /** macOS notification on attention calls. */
  notify: true,
  /** Do-not-disturb window in local time, "HH:MM"–"HH:MM"; empty = off. */
  dndFrom: "",
  dndTo: "",
  /** Refuse non-commercial engines everywhere (adds a UI badge when off). */
  commercialMode: true,
  /** macOS `say` is personal-use only; this is the explicit opt-in for it. */
  allowPersonalVoice: false,
  /** Hard cap on spoken characters; longer text is shortened and announced. */
  maxChars: 300,
  /** Named cloned voices: {id, name, engine, path, createdAt, rightsConfirmed}. */
  voices: [],
});

/**
 * The shape of `GET /state`. The client renders only from this — no second
 * source of truth, no direct settings access (the client has no settings
 * service at all in 0.2.x).
 */
export function emptyState(now = Date.now()) {
  return {
    ok: true,
    version: 1,
    plugin: PLUGIN,
    pluginVersion: VERSION,
    now,
    /** Resolved user settings (defaults merged). */
    config: { ...DEFAULTS },
    /** Which output the next job will use: "browser" | "system". */
    output: "system",
    /** Engine availability, one record per engine id. */
    engines: [],
    /** Flat voice list across engines, each tagged with its engine. */
    voices: [],
    /** Currently speaking job or null. */
    current: null,
    /** Jobs waiting, oldest first. */
    queue: [],
    /** Pending attention call or null. */
    attention: null,
    /** Last spoken text, for the "read that again" button. */
    last: null,
    /** Last error, or null. */
    error: null,
    /** Engine provisioning progress, or null. */
    setup: null,
  };
}

/** Hard limits the Host enforces regardless of what the UI sends. */
export const LIMITS = Object.freeze({
  maxChars: 1200,
  maxQueue: 24,
  maxText: 20000,
  segmentMaxChars: 220,
  audioCacheBytes: 200 * 1024 * 1024,
  statePollMs: 1000,
  presenceFreshMs: 6000,
});

/** True when `value` is a plain object. Used by the config patch endpoint. */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clamp a number into [min, max], falling back to `fallback` when not finite. */
export function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Local "HH:MM" → minutes since midnight, or null when not a valid time. */
export function parseClock(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** True when `now` falls inside the configured do-not-disturb window. */
export function inQuietHours(config, now = new Date()) {
  const from = parseClock(config?.dndFrom ?? "");
  const to = parseClock(config?.dndTo ?? "");
  if (from === null || to === null) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  // A window that wraps midnight (22:00–07:00) is the common case, so handle it.
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}
