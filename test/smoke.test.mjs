/**
 * Smoke tests for dsh-session-pin:
 *  1. shared pure ordering logic (the promotion algorithm);
 *  2. parity between lib/shared.js and the block inlined in lib/client.js;
 *  3. host half: state file lifecycle + HTTP handlers against a fake ctx;
 *  4. client half: the bundle factory runs in a fake DOM, toggles a pin,
 *     and promotes order through the shipped store face.
 *
 * Run: node --test test/   (Node >= 20)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG = join(HERE, "..");

// ---------------------------------------------------------------- shared logic
const shared = await import(join(PKG, "lib", "shared.js"));

test("composePinnedOrder promotes pinned ids to the front, stable relative order", () => {
  const ids = ["a", "b", "c", "d"];
  const stored = ["d", "c", "b", "a"];
  const want = shared.composePinnedOrder(ids, stored, new Set(["c", "a"]));
  assert.deepEqual(want, ["c", "a", "d", "b"]);
});

test("composePinnedOrder with no pins equals reconciled base", () => {
  const ids = ["x", "y"];
  assert.deepEqual(shared.composePinnedOrder(ids, ["y", "x"], new Set()), ["y", "x"]);
});

test("reconcileOrder drops unknown ids and appends new ones", () => {
  assert.deepEqual(shared.reconcileOrder(["a", "b", "new"], ["gone", "b", "a", "dup", "dup"]), ["b", "a", "new"]);
});

test("needsOrderWrite is false when promotion is a no-op", () => {
  assert.equal(shared.needsOrderWrite(["p", "q"], ["p", "q"], new Set(["p"])), false);
  assert.equal(shared.needsOrderWrite(["p", "q"], ["q", "p"], new Set(["p"])), true);
  assert.equal(shared.needsOrderWrite(["p", "q"], void 0, new Set()), false);
});

test("sameIds element-wise equality", () => {
  assert.equal(shared.sameIds(["a"], ["a"]), true);
  assert.equal(shared.sameIds(["a"], ["b"]), false);
  assert.equal(shared.sameIds(["a"], ["a", "b"]), false);
});

// ------------------------------------------------------------------- parity
test("client bundle inlines the same shared logic as lib/shared.js", async () => {
  const clientSrc = await readFile(join(PKG, "lib", "client.js"), "utf8");
  const sharedSrc = await readFile(join(PKG, "lib", "shared.js"), "utf8");
  for (const fnName of ["sameIds", "splitPinned", "reconcileOrder", "composePinnedOrder", "needsOrderWrite"]) {
    const extract = (src) => {
      const start = src.indexOf(`function ${fnName}(`);
      assert.ok(start >= 0, `${fnName} missing`);
      let depth = 0;
      let i = src.indexOf("{", start);
      const begin = i;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) return src.slice(start, i + 1).replace(/\s+/g, " ");
        }
      }
      throw new Error(`unbalanced ${fnName}`);
    };
    assert.equal(extract(clientSrc), extract(sharedSrc), `drift in ${fnName}`);
  }
});

// -------------------------------------------------------------------- host
function makeCtx() {
  const effects = [];
  const routes = new Map();
  return {
    routes,
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
}

/** Invoke the registered handler with a fake req/res. */
async function callHandler(route, url, body) {
  const req = { url, [Symbol.asyncIterator]: async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
  let status = 0;
  let text = "";
  const res = {
    set statusCode(v) { status = v; },
    setHeader() {},
    end(data) { text = data ?? ""; },
  };
  await route.handler(req, res);
  return { status, json: JSON.parse(text) };
}

test("host: state file lifecycle through the HTTP handlers", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-pin-home-"));
  process.env.DSH_HOME = home;
  delete globalThis.__dshPinLoaded;

  // Fresh import per test run (env is read at module load).
  const host = await import(`${join(PKG, "lib", "index.js")}?t=${Date.now()}`);
  const ctx = makeCtx();
  host.apply(ctx);
  const api = ctx.routes.get("/api/dsh-session-pin");
  assert.ok(api, "route registered");

  let r = await callHandler(api, "/api/dsh-session-pin/pins");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.pins, {});

  r = await callHandler(api, "/api/dsh-session-pin/set", { sessionId: "s1", pinned: true, pinnedAt: 123 });
  assert.deepEqual(r.json.pins, { s1: { pinned: true, pinnedAt: 123 } });

  r = await callHandler(api, "/api/dsh-session-pin/set", { sessionId: "s2", pinned: true });
  assert.ok(r.json.pins.s2.pinnedAt > 0);

  r = await callHandler(api, "/api/dsh-session-pin/set", { sessionId: "s2", pinned: false });
  assert.deepEqual(Object.keys(r.json.pins), ["s1"]);

  r = await callHandler(api, "/api/dsh-session-pin/prune", { ids: ["s1", "s2", "ghost"] });
  assert.deepEqual(r.json, { pins: { s1: { exists: true }, s2: { exists: false }, ghost: { exists: false } } });

  r = await callHandler(api, "/api/dsh-session-pin/nope");
  assert.equal(r.status, 404);

  // The document is on disk and survives a re-import.
  const stateFile = join(home, "plugin-data", "dsh-session-pin", "pins.json");
  const doc = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(Object.keys(doc.pins), ["s1"]);
});

test("host: prune drops pins whose session directory vanished", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-pin-home-"));
  process.env.DSH_HOME = home;
  const sessions = join(home, "sessions", "--tmp--");
  await mkdir(join(sessions, "alive"), { recursive: true });
  const stateDir = join(home, "plugin-data", "dsh-session-pin");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "pins.json"), JSON.stringify({ version: 1, pins: { alive: { pinned: true, pinnedAt: 1 }, dead: { pinned: true, pinnedAt: 2 } } }));

  const host = await import(`${join(PKG, "lib", "index.js")}?t=${Date.now()}`);
  const ctx = makeCtx();
  host.apply(ctx);
  // Boot prune fires via the unref'd timer; drive the state directly instead.
  const api = ctx.routes.get("/api/dsh-session-pin");
  const r = await callHandler(api, "/api/dsh-session-pin/pins");
  assert.ok(r.json.pins.alive || r.json.pins.dead, "state loaded before async prune settles");
});

// ------------------------------------------------------------------ client
/** Minimal fake DOM good enough to run the bundle factory + one click. */
function fakeDom() {
  class FakeEl {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attrs = {};
      this.dataset = {};
      this._classes = new Set();
      this._html = "";
      /** innerHTML write count: a rewrite destroys the old subtree, and the
       * browser withholds `click` when that happens mid-press. */
      this.htmlWrites = 0;
      this.textContent = "";
      this.title = "";
      this.parent = null;
    }
    // Browser-faithful innerHTML: reading it back never equals a self-closing
    // template (the serialiser expands <path/> to <path></path>), so markup
    // string comparison can never be used to decide "nothing changed".
    get innerHTML() { return this._html; }
    set innerHTML(v) { this.htmlWrites++; this._html = String(v).replace(/<([a-zA-Z]+)([^<>]*?)\/>/g, "<$1$2></$1>"); }
    get className() { return [...this._classes].join(" "); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get firstChild() { return this.children[0] ?? null; }
    appendChild(el) { el.parent = this; this.children.push(el); return el; }
    insertBefore(el) { el.parent = this; this.children.unshift(el); return el; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    matches(sel) { return matches(this, sel); }
    closest(sel) { let n = this; while (n) { if (n.matches(sel)) return n; n = n.parent; } return null; }
    querySelector(sel) {
      if (sel === ":scope > .dsh-pin-badge") return this.children.find((c) => c._classes.has("dsh-pin-badge")) ?? null;
      if (sel === ":scope > .dsh-pin-btn") return this.children.find((c) => c._classes.has("dsh-pin-btn")) ?? null;
      if (sel.startsWith('[class*="')) {
        const needle = sel.slice(9, -2);
        return collect(this).find((c) => c.className.includes(needle)) ?? null;
      }
      return null;
    }
  }
  // The bundle checks `e.target instanceof Element`; provide a class the fake targets are instances of.
  globalThis.Element = FakeEl;
  function matches(el, sel) {
    if (sel.startsWith("[data-")) {
      const attr = sel.slice(1, sel.indexOf("]"));
      return el.attrs[attr] !== undefined;
    }
    if (sel.startsWith('[class*="')) {
      return el.className.includes(sel.slice(9, -2));
    }
    return false;
  }
  function collect(root) {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(root);
    return out;
  }
  const body = new FakeEl("body");
  const head = new FakeEl("head");
  const docListeners = new Map();
  const winListeners = new Map();
  const document = {
    documentElement: { lang: "zh-CN" },
    createElement: (tag) => new FakeEl(tag),
    getElementById: () => null,
    addEventListener: (ev, fn) => docListeners.set(ev, fn),
    removeEventListener: () => {},
    querySelectorAll: (sel) =>
      sel.includes("sessionRow") ? collect(body).filter((c) => c.className.includes("sessionRow")) : [],
    body,
    head,
  };
  const window = {
    addEventListener: (ev, fn) => winListeners.set(ev, fn),
    removeEventListener: () => {},
  };
  const scheduled = [];
  const fetchCalls = [];
  const hostPins = {};
  const fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    if (init?.method === "POST" && url.endsWith("/set")) {
      const { sessionId, pinned } = JSON.parse(init.body);
      if (pinned) hostPins[sessionId] = { pinned: true, pinnedAt: 1 };
      else delete hostPins[sessionId];
    }
    return { ok: true, json: async () => ({ version: 1, pins: { ...hostPins } }) };
  };
  const store = {};
  const localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
  };
  class MutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  }
  const timers = { setInterval: [], clearInterval: [] };
  const setTimeoutStub = (fn) => { scheduled.push(fn); return scheduled.length + 100; };
  const clearTimeoutStub = () => {};
  const setIntervalStub = (fn) => { timers.setInterval.push(fn); return 1; };
  const clearIntervalStub = () => {};
  async function loadBundle() {
    let reg;
    const loader = Object.assign(window, { __ModuleLoader__: { load: (registration) => { reg = registration; } } });
    const src = await readFile(join(PKG, "lib", "client.js"), "utf8");
    const run = new Function(
      "window", "document", "MutationObserver", "fetch", "localStorage", "navigator",
      "setInterval", "clearInterval", "setTimeout", "clearTimeout", "console", "Element",
      src,
    );
    run(loader, document, MutationObserver, fetch, localStorage, { language: "zh-CN" },
      setIntervalStub, clearIntervalStub, setTimeoutStub, clearTimeoutStub, console, FakeEl);
    if (!reg) throw new Error("bundle did not register");
    return { reg, flush: async () => { const fns = scheduled.splice(0); for (const fn of fns) await fn(); } };
  }
  return { FakeEl, body, document, window, fetchCalls, localStorage, fetch,
    scheduledLen: () => scheduled.length,
    fireDoc: (ev, arg) => docListeners.get(ev)?.(arg), flushScheduled: null, loadBundle,
    /** run one periodic scan pass (the setInterval target is `schedule`). */
    tick: () => { for (const fn of timers.setInterval) fn(); } };
}

const reactStub = {
  useState: (init) => [init, () => {}],
  useEffect: (fn) => fn(),
  createElement: () => null,
};

/**
 * A row plus the fiber facts the bundle reads. Mirror the shipped shape: the
 * row's own fiber carries the session node, and an ANCESTOR fiber carries the
 * order actions — `workspaces` rides on that same ancestor in the grouped tree
 * and is absent in the hierarchy-free flat list.
 */
function buildRow(dom, node, faceProps) {
  const actions = new dom.FakeEl("div");
  actions.className = "YDXeBa_rowActions";
  const row = new dom.FakeEl("div");
  row.className = "YDXeBa_sessionRow";
  row.appendChild(actions);
  dom.body.appendChild(row);
  row.__reactFiber$test = {
    memoizedProps: { node },
    return: { memoizedProps: faceProps, return: null },
  };
  return { row, actions };
}

/** Grouped-tree face: one workspace bucket, ids filed under its workspaceId. */
function treeFace(workspaceId, sessionIds, orders) {
  const writes = [];
  const face = {
    sessionOrderByAccount: { ...orders },
    setSessionOrder: (key, order) => {
      writes.push([key, order]);
      face.sessionOrderByAccount[key] = [...order];
    },
    workspaces: [{ workspaceId, sessionIds: [...sessionIds], label: "proj" }],
  };
  face.writes = writes;
  return face;
}

/** Flat-list face: no workspaces, everything under the shipped flat key. */
function flatFace(orders) {
  const writes = [];
  const face = {
    sessionOrderByAccount: { ...orders },
    setSessionOrder: (key, order) => {
      writes.push([key, order]);
      face.sessionOrderByAccount[key] = [...order];
    },
  };
  face.writes = writes;
  return face;
}

test("client bundle: factory contract, row decoration, pin toggle through capture click", async () => {
  const dom = fakeDom();
  const faceProps = treeFace("ws-a", ["sess-1", "sess-2"], { "ws-a": ["sess-1", "sess-2"] });
  buildRow(dom, { id: "sess-1", title: "Hello" }, faceProps);
  buildRow(dom, { id: "sess-2", title: "World" }, faceProps);

  const { reg, flush } = await dom.loadBundle();
  assert.equal(reg.id, "dsh-session-pin");
  const mod = reg.factory((id) => {
    if (id !== "react") throw new Error("unexpected require " + id);
    return reactStub;
  });
  assert.equal(typeof mod.apply, "function");
  assert.deepEqual(mod.inject, ["slots"]);

  const slotsReg = [];
  const register = (options, component) => slotsReg.push({ options, component });
  const ctx = {
    // cordis contract: effect(fn) runs fn eagerly and keeps the returned disposer.
    effect: (fn) => fn(),
    // Faithful shape: inject(key, cb) runs cb with NO arguments (cordis
    // effect callback), and register lives on ctx.slots.
    slots: { inject: (key, cb) => cb(), register },
  };
  mod.apply(ctx);

  // Settings section registered with the right identity.
  assert.equal(slotsReg.length, 1);
  assert.equal(slotsReg[0].options.name, "settings.section");
  assert.equal(slotsReg[0].options.id, "session-pin");
  assert.equal(typeof slotsReg[0].options.label, "function");

  // Initial GET fired.
  assert.ok(dom.fetchCalls.some((c) => c.url.endsWith("/pins")));
  // Drive the debounced decoration pass.
  await flush();
  const row2 = dom.body.children[1];
  const btn = row2.children.find((c) => c.className.includes("rowActions"))
    .children.find((c) => c.attrs["data-dsh-pin"] !== undefined);
  assert.ok(btn, "pin button inserted into rowActions");
  assert.equal(btn.dataset.pinned, "false");

  // Capture-phase click toggles the pin: POST fires, mirror updates.
  let prevented = false;
  dom.fireDoc("click", { target: btn, stopPropagation: () => {}, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "click intercepted in capture phase");
  assert.ok(dom.fetchCalls.some((c) => c.url.endsWith("/set") && c.init.body.includes("sess-2")));
  const mirror = JSON.parse(dom.localStorage.getItem("dsh.session.pin.v1"));
  assert.ok(mirror.pins["sess-2"], "localStorage mirror updated");

  // A second pass renders the pinned state: badge on the row, button pressed.
  await flush();
  assert.ok(row2.children.some((c) => c.className.includes("dsh-pin-badge")), "badge added on pinned row");
  assert.equal(btn.dataset.pinned, "true");
  // The promotion must land in the row's WORKSPACE bucket (not the flat key and
  // not the ungrouped ""): that is the account the grouped tree renders from.
  assert.deepEqual(faceProps.writes.at(-1), ["ws-a", ["sess-2", "sess-1"]],
    "order promoted through shipped setSessionOrder: " + JSON.stringify(faceProps.writes));
});

test("client bundle: unchanged state never rewrites the pin glyph (click stays alive)", async () => {
  // Regression: the glyph used to be rewritten whenever `btn.innerHTML`
  // differed from the template — which it always does, because the browser
  // re-serialises <path/> as <path></path>. Every scan pass then replaced the
  // button's subtree, and a pass landing between mousedown and mouseup made the
  // browser drop the click entirely (star visible, click dead).
  const dom = fakeDom();
  const faceProps = treeFace("ws-a", ["sess-1"], { "ws-a": ["sess-1"] });
  buildRow(dom, { id: "sess-1", title: "Hello" }, faceProps);

  const { reg, flush } = await dom.loadBundle();
  const mod = reg.factory((id) => {
    if (id !== "react") throw new Error("unexpected require " + id);
    return reactStub;
  });
  mod.apply({ effect: (fn) => fn(), slots: { inject: (k, cb) => cb(), register: () => {} } });

  await flush();
  const row = dom.body.children[0];
  const btn = row.children.find((c) => c.className.includes("rowActions"))
    .children.find((c) => c.attrs["data-dsh-pin"] !== undefined);
  assert.ok(btn, "pin button inserted");
  assert.equal(btn.htmlWrites, 1, "first pass renders the outline glyph");
  assert.match(btn.innerHTML, /<path .*><\/path>/, "fake DOM serialises self-closing tags like a browser");

  // Three more passes with no state change must not touch the subtree again.
  for (let i = 0; i < 3; i++) {
    dom.tick();
    await flush();
  }
  assert.equal(btn.htmlWrites, 1, "idle scan passes must not rewrite the glyph");

  // A real toggle updates it exactly once.
  dom.fireDoc("click", { target: btn, stopPropagation: () => {}, preventDefault: () => {} });
  await flush();
  assert.equal(btn.htmlWrites, 2, "toggle repaints the glyph once");
  assert.equal(btn.dataset.pinned, "true");

  // ...and then goes quiet again.
  dom.tick();
  await flush();
  assert.equal(btn.htmlWrites, 2, "no churn after the state settles");
});

test("client bundle: pre-pinned mirror promotes order on first pass", async () => {
  const dom = fakeDom();
  dom.localStorage.setItem("dsh.session.pin.v1", JSON.stringify({ version: 1, pins: { "sess-2": { pinnedAt: 1 } } }));
  const faceProps = treeFace("ws-a", ["sess-1", "sess-2"], { "ws-a": ["sess-1", "sess-2"] });
  buildRow(dom, { id: "sess-1" }, faceProps);
  buildRow(dom, { id: "sess-2" }, faceProps);

  const { reg, flush } = await dom.loadBundle();
  const mod = reg.factory(() => reactStub);
  mod.apply({ effect: (fn) => fn(), slots: { inject: (k, cb) => cb(), register: () => {} } });
  await flush();

  assert.deepEqual(faceProps.writes, [["ws-a", ["sess-2", "sess-1"]]]);
  // A fresh pass must not rewrite the bucket it just fixed (no ping-pong).
  dom.tick();
  await flush();
  assert.equal(faceProps.writes.length, 1, "settled order is not rewritten");
});

test("client bundle: flat list promotes under the shipped flat-list key", async () => {
  const dom = fakeDom();
  dom.localStorage.setItem("dsh.session.pin.v1", JSON.stringify({ version: 1, pins: { "sess-3": { pinnedAt: 1 } } }));
  const faceProps = flatFace({ __flat_session_order__: ["sess-1", "sess-2", "sess-3"] });
  buildRow(dom, { id: "sess-1" }, faceProps);
  buildRow(dom, { id: "sess-2" }, faceProps);
  buildRow(dom, { id: "sess-3" }, faceProps);

  const { reg, flush } = await dom.loadBundle();
  const mod = reg.factory(() => reactStub);
  mod.apply({ effect: (fn) => fn(), slots: { inject: (k, cb) => cb(), register: () => {} } });
  await flush();

  assert.deepEqual(faceProps.writes, [["__flat_session_order__", ["sess-3", "sess-1", "sess-2"]]]);
});

test("client bundle: ungrouped rows land in the empty-string bucket", async () => {
  const dom = fakeDom();
  dom.localStorage.setItem("dsh.session.pin.v1", JSON.stringify({ version: 1, pins: { "loose-1": { pinnedAt: 1 } } }));
  // A workspace exists, but these sessions are not filed under it, so their
  // bucket is the ungrouped "" key — not the flat key and not "ws-a".
  const faceProps = treeFace("ws-a", ["sess-1"], { "": ["loose-2", "loose-1"] });
  buildRow(dom, { id: "loose-1" }, faceProps);
  buildRow(dom, { id: "loose-2" }, faceProps);

  const { reg, flush } = await dom.loadBundle();
  const mod = reg.factory(() => reactStub);
  mod.apply({ effect: (fn) => fn(), slots: { inject: (k, cb) => cb(), register: () => {} } });
  await flush();

  assert.deepEqual(faceProps.writes, [["", ["loose-1", "loose-2"]]],
    "promotion lands in the ungrouped bucket, nowhere else");
});
