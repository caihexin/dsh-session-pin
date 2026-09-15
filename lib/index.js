/**
 * Host half of dsh-session-pin (loaded as ESM by the DSH loader).
 *
 * Owns the durable pin state: a JSON document under the profile storage
 * directory, an HTTP face under /api/dsh-session-pin/* for every browser,
 * and an hourly prune that drops pins whose session no longer has a log on
 * disk. No cordis services are required: paths derive from DSH_HOME (env,
 * else ~/.dsh), matching the shipped session-persistence backend.
 *
 * @module host
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { API_GET, API_PRUNE, API_SET, PLUGIN_ID, STATE_VERSION } from './shared.js';

export const name = PLUGIN_ID;
/** Cordis service dependency: the HTTP face mounts on the host web server. */
export const inject = ['webServer'];

/** Log one tagged line (the loader tags console per plugin; plain console keeps working). */
const log = console.log.bind(console, `[${PLUGIN_ID}]`);
const logErr = console.error.bind(console, `[${PLUGIN_ID}]`);

/**
 * Resolve DSH home: the DSH_HOME env when set, else the ~/.dsh default.
 * @returns {string} absolute profile-home path.
 */
function resolveDshHome() {
  const raw = process.env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return resolve(raw.trim());
  return join(homedir(), '.dsh');
}

/** Absolute path of this plugin's state document. */
const STATE_FILE = join(resolveDshHome(), 'plugin-data', PLUGIN_ID, 'pins.json');
/** Directory holding every profile's session logs. */
const SESSIONS_DIR = join(resolveDshHome(), 'sessions');

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const BOOT_PRUNE_DELAY_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ID_LEN = 256;

/**
 * Parse a state document from raw JSON text.
 * @param {string} raw - file contents.
 * @returns {{version: number, pins: Record<string, {pinned: boolean, pinnedAt: number}>}} the state; a fresh empty state when unparseable.
 */
function parseState(raw) {
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || typeof doc.pins !== 'object' || doc.pins === null) {
      throw new Error('unexpected shape');
    }
    const pins = {};
    for (const [id, value] of Object.entries(doc.pins)) {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) continue;
      if (!value || typeof value !== 'object') continue;
      if ((value.pinned ?? true) === true) {
        const pinnedAt = typeof value.pinnedAt === 'number' && value.pinnedAt > 0 ? value.pinnedAt : 0;
        pins[id] = { pinned: true, pinnedAt };
      }
    }
    return { version: STATE_VERSION, pins };
  } catch (error) {
    logErr('state unparseable, starting empty:', error);
    return { version: STATE_VERSION, pins: {} };
  }
}

/**
 * List a directory's entry names, tolerating unreadable directories.
 * @param {string} dir - directory path.
 * @returns {Promise<string[]>} entry names (empty when unreadable).
 */
async function readdirSafe(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Collect every session id that has a log directory on disk. The shipped
 * layout is sessions/<projectKey>--/<sessionId>/, so ids are second-level
 * directory names.
 * @returns {Promise<Set<string>>} known session ids.
 */
export async function listDiskSessionIds() {
  const known = new Set();
  for (const project of await readdirSafe(SESSIONS_DIR)) {
    for (const id of await readdirSafe(join(SESSIONS_DIR, project))) known.add(id);
  }
  return known;
}

/**
 * Drop pins whose session id is not in `known` (pure; drives the hourly prune).
 * @param {{version: number, pins: Record<string, unknown>}} doc - current document.
 * @param {Set<string>} known - ids with a session log on disk.
 * @returns {{doc: {version: number, pins: Record<string, unknown>}, changed: boolean}} the pruned document.
 */
export function pruneDocument(doc, known) {
  let changed = false;
  const pins = {};
  for (const [id, value] of Object.entries(doc.pins)) {
    if (known.has(id)) pins[id] = value;
    else changed = true;
  }
  return changed ? { doc: { version: doc.version, pins }, changed: true } : { doc, changed: false };
}

/**
 * Host half entry: serves the pin state and keeps it pruned.
 * @param {object} ctx - the cordis plugin context (injects webServer).
 */
export function apply(ctx) {
  let doc = { version: STATE_VERSION, pins: {} };
  let loaded = false;
  /** @type {Promise<void> | null} in-flight load. */
  let loading = null;
  /** @type {Promise<void>} serialized write chain. */
  let writing = Promise.resolve();

  /** Load the state document once; a missing file is an empty state. */
  const ensureLoaded = () => {
    if (loaded) return Promise.resolve();
    loading ??= (async () => {
      try {
        doc = parseState(await readFile(STATE_FILE, 'utf8'));
      } catch (error) {
        if (!error || error.code !== 'ENOENT') logErr('state read failed, starting empty:', error);
        doc = { version: STATE_VERSION, pins: {} };
      }
      loaded = true;
    })();
    return loading;
  };

  /**
   * Serialize a full-document write (temp + rename for atomicity).
   * @returns {Promise<void>} resolves when the document is on disk.
   */
  const persist = () => {
    writing = writing
      .then(async () => {
        await mkdir(dirname(STATE_FILE), { recursive: true });
        const tmp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, JSON.stringify(doc), 'utf8');
        await rename(tmp, STATE_FILE);
      })
      .catch((error) => logErr('state write failed:', error));
    return writing;
  };

  /**
   * Send a JSON response.
   * @param {import("node:http").ServerResponse} res - response.
   * @param {number} status - HTTP status code.
   * @param {unknown} body - JSON-serializable payload.
   */
  const sendJson = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(JSON.stringify(body));
  };

  /**
   * Read and parse a JSON request body (size-capped).
   * @param {import("node:http").IncomingMessage} req - request.
   * @returns {Promise<any>} the parsed body ({} when empty).
   * @throws {Error} on oversize payloads or invalid JSON.
   */
  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Error('payload too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  };

  /**
   * Drop pins whose session has no log directory under the sessions root.
   */
  const prune = async () => {
    await ensureLoaded();
    if (Object.keys(doc.pins).length === 0) return;
    const known = await listDiskSessionIds();
    const next = pruneDocument(doc, known);
    if (next.changed) {
      doc = next.doc;
      await persist();
      log(`pruned stale pins (${Object.keys(doc.pins).length} remain)`);
    }
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        // Prefix route: the router dispatches longest-prefix-wins, so every
        // /api/dsh-session-pin/* subpath reaches this handler (an `exact`
        // registration would only catch the bare path).
        kind: 'prefix',
        path: '/api/' + PLUGIN_ID,
        async handler(req, res) {
          // Compare pathnames only: a query string (cache busters) must not
          // change routing.
          const raw = req.url ?? '';
          const route = raw.split('?')[0].replace(/\/+$/, '') || '/';
          if (route !== API_GET && route !== API_SET && route !== API_PRUNE) {
            return sendJson(res, 404, { error: 'not found' });
          }
          await ensureLoaded();
          try {
            if (route === API_GET) return sendJson(res, 200, { ...doc, pins: { ...doc.pins } });
            const body = await readBody(req);
            if (route === API_PRUNE) {
              const ids = Array.isArray(body?.ids)
                ? body.ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN)
                : [];
              const result = {};
              for (const id of ids) result[id] = { exists: id in doc.pins };
              return sendJson(res, 200, { pins: result });
            }
            // API_SET
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
            if (sessionId.length === 0 || sessionId.length > MAX_ID_LEN) {
              return sendJson(res, 400, { error: 'invalid sessionId' });
            }
            if (body?.pinned === true) {
              const pinnedAt = typeof body?.pinnedAt === 'number' && body.pinnedAt > 0 ? body.pinnedAt : Date.now();
              doc = { version: STATE_VERSION, pins: { ...doc.pins, [sessionId]: { pinned: true, pinnedAt } } };
            } else if (sessionId in doc.pins) {
              const pins = { ...doc.pins };
              delete pins[sessionId];
              doc = { version: STATE_VERSION, pins };
            }
            await persist();
            return sendJson(res, 200, { ...doc, pins: { ...doc.pins } });
          } catch (error) {
            logErr(`${route} failed:`, error);
            sendJson(res, 500, { error: 'internal' });
          }
        },
      }),
    `${PLUGIN_ID}: api`,
  );

  ctx.effect(
    () => {
      const timer = setInterval(() => {
        prune().catch((error) => logErr('prune failed:', error));
      }, PRUNE_INTERVAL_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    `${PLUGIN_ID}: prune`,
  );

  // Warm the document so the first browser GET is fast; prune shortly after boot.
  const boot = setTimeout(
    () => void ensureLoaded().then(() => prune().catch((error) => logErr('boot prune failed:', error))),
    BOOT_PRUNE_DELAY_MS,
  );
  boot.unref?.();
}
