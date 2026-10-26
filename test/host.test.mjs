//
//  host.test.mjs — load the Host half in plain Node and prove it cannot take
//  the app down.
//
//  WHY THIS TEST EXISTS: the first installed build called
//  `connection.rpc.intercept('/api', …)`, which is already owned by the Typert
//  Gateway. The rejection escaped the plugin's async initializer, 0.2.x treats
//  an unhandled rejection as a fatal load failure, and the whole Desktop app
//  restarted. The lesson is not "do not use intercept" — it is that **every**
//  async path of a plugin must settle into a value or a stored error, never into
//  a rejected promise. This test exercises the paths that run at load: route
//  registration (including a colliding/incorrect one), engine detection, the
//  tool's status action and the HTTP handler.
//
//  Run: node test/host.test.mjs
//

import assert from "node:assert/strict";
import { register } from "node:module";

register("./loader.mjs", import.meta.url);

const { default: plugin } = await import("../lib/index.js").then((module) => ({ default: module }));

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function makeContext({ routeThrows = false, webServer = true, reflect = undefined } = {}) {
  const captured = {
    tools: [],
    events: [],
    sections: [],
    provided: [],
    routes: [],
    cleanups: [],
  };
  const fakeWebServer = webServer
    ? {
        getOrigin: () => "http://127.0.0.1:0",
        register(route) {
          if (routeThrows) throw new Error("prefix already registered");
          captured.routes.push(route);
          return () => {};
        },
      }
    : undefined;
  const fakePrompt = {
    section(section) {
      captured.sections.push(section);
      return () => {};
    },
  };
  const ctx = {
    tools: {
      register(definition) {
        captured.tools.push(definition);
        return () => {};
      },
    },
    on(name, listener) {
      captured.events.push({ name, listener });
      return () => {};
    },
    effect(callback) {
      const cleanup = callback();
      captured.cleanups.push(cleanup);
      return () => {};
    },
    provide(key, value) {
      captured.provided.push({ key, value });
      return () => {};
    },
    get(name) {
      if (name === "webServer") return fakeWebServer;
      if (name === "systemPrompt") return fakePrompt;
      return undefined;
    },
    reflect,
    logger: () => ({ info() {}, warn() {}, error() {} }),
  };
  return { ctx, captured };
}

function fakeRequest(url, method = "GET", body = null) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeResponse() {
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers ?? {};
      return res;
    },
    end(chunk) {
      res.body = chunk ?? "";
      return res;
    },
  };
  return res;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------- 1. plain load */

{
  const { ctx, captured } = makeContext();
  plugin.apply(ctx, {});
  await wait(1200); // initializer: mkdir, settings, remote, engine detection

  check("apply registers the dsh_phononspeak tool", () => {
    assert.equal(captured.tools.length, 1);
    assert.equal(captured.tools[0].name, "dsh_phononspeak");
    assert.equal(captured.tools[0].parameters.action.required, true);
  });

  check("apply registers the HTTP prefix route once", () => {
    assert.equal(captured.routes.length, 1);
    assert.equal(captured.routes[0].kind, "prefix");
    assert.equal(captured.routes[0].path, "/dsh-phononspeak/");
  });

  check("apply registers the approval and user-question waterfalls", () => {
    const names = captured.events.map((event) => event.name).sort();
    assert.deepEqual(names, ["approval/request", "user-questions/request"]);
  });

  check("apply registers a dynamic prompt section", () => {
    assert.equal(captured.sections.length, 1);
    assert.equal(captured.sections[0].name, "phononspeak");
    assert.equal(typeof captured.sections[0].text, "function");
  });

  check("the prompt section text reflects the live settings", () => {
    const text = captured.sections[0].text({});
    assert.match(text, /dsh_phononspeak/);
    assert.match(text, /Nikdy nepředčítej/);
  });

  check("the tool answers status with engine availability", async () => {
    const raw = await captured.tools[0].execute({ action: "status" });
    const result = JSON.parse(raw);
    assert.equal(result.ok, true);
    assert.equal(result.enabled, true);
    assert.ok(Array.isArray(result.engines));
    assert.ok(result.engines.some((engine) => engine.id === "supertonic"));
  });

  check("the HTTP state route answers JSON", async () => {
    const req = fakeRequest("/dsh-phononspeak/state");
    const res = fakeResponse();
    await captured.routes[0].handler(req, res);
    assert.equal(res.status, 200);
    const state = JSON.parse(res.body);
    assert.equal(state.ok, true);
    assert.equal(state.version, 1);
    assert.equal(typeof state.config.voice, "string");
    assert.ok(Array.isArray(state.engines));
  });

  check("an unknown RPC-ish path answers 404 JSON", async () => {
    const req = fakeRequest("/dsh-phononspeak/nope");
    const res = fakeResponse();
    await captured.routes[0].handler(req, res);
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  check("the private service is exposed for other plugins", () => {
    assert.equal(captured.provided.length, 1);
    assert.equal(captured.provided[0].key, "dshPhononspeak");
    assert.equal(typeof captured.provided[0].value.speak, "function");
  });

  check("cleanup runs without throwing", () => {
    for (const cleanup of captured.cleanups) {
      if (typeof cleanup === "function") cleanup();
    }
  });
}

/* --------------------------------------------- 2. a broken route must not crash */

{
  const { ctx, captured } = makeContext({ routeThrows: true });
  let threw = null;
  try {
    plugin.apply(ctx, {});
    await wait(900);
  } catch (error) {
    threw = error;
  }
  check("a colliding HTTP route degrades instead of failing the load", () => {
    assert.equal(threw, null, `apply threw: ${threw}`);
    assert.equal(captured.tools.length, 1, "the tool must still be registered");
    assert.equal(captured.routes.length, 0);
  });
}

/* ------------------------------------------ 3. no web server at all (headless) */

{
  const { ctx, captured } = makeContext({ webServer: false });
  plugin.apply(ctx, {});
  await wait(700);
  check("a headless host without webServer still loads the tool", () => {
    assert.equal(captured.tools.length, 1);
    assert.equal(captured.routes.length, 0);
  });
}

console.log(`\nhost.test — ${passed} checks passed`);
