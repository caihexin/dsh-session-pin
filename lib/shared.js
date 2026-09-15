/**
 * Shared constants and pure helpers between the host half and the browser
 * bundle. The host imports this file as ESM; the browser bundle inlines the
 * same block inside its factory closure (no module system there), and
 * test/smoke.test.mjs guards the two copies against drift.
 *
 * Keep it dependency-free and free of Node/browser APIs.
 *
 * @module shared
 */

/** Plugin id (loader entry, log tag, API root, style owner). */
export const PLUGIN_ID = 'dsh-session-pin';

/** HTTP API root served by the host half. */
export const API_PATH = '/api/' + PLUGIN_ID;
/** GET  -> full state document {version, pins:{id:{pinned,pinnedAt}}} */
export const API_GET = API_PATH + '/pins';
/** POST {sessionId, pinned, pinnedAt} -> refreshed state document */
export const API_SET = API_PATH + '/set';
/** POST {ids:[...]} -> {pins:{id:{exists}}} — session existence probe */
export const API_PRUNE = API_PATH + '/prune';

/** Version marker inside the host state document. */
export const STATE_VERSION = 1;

/**
 * Whether the two id sequences are equal element-wise.
 * @param {string[]} a - first sequence.
 * @param {string[]} b - second sequence.
 * @returns {boolean} whether they match exactly.
 */
export function sameIds(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Partition an ordered id list into pinned (stable, keeping the manual
 * relative order) and rest (all non-pinned ids in their given order).
 * @param {string[]} order - manual order (pinned ids sort within it).
 * @param {Set<string>} pinnedSet - ids currently pinned.
 * @returns {{pinned: string[], rest: string[]}} the two buckets.
 */
export function splitPinned(order, pinnedSet) {
  const pinned = [];
  const rest = [];
  for (let i = 0; i < order.length; i++) {
    if (pinnedSet.has(order[i])) pinned.push(order[i]);
    else rest.push(order[i]);
  }
  return { pinned: pinned, rest: rest };
}

/**
 * The manual order as the shipped UI would store it after its own
 * reconciliation: stored entries (unknown ones dropped) followed by
 * session ids missing from the store, in list order.
 * @param {string[]} sessionIds - current account session ids (list order).
 * @param {string[]|undefined} stored - previously stored manual order.
 * @returns {string[]} reconciled order.
 */
export function reconcileOrder(sessionIds, stored) {
  if (!stored || stored.length === 0) return sessionIds.slice();
  const byId = new Set(sessionIds);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < stored.length; i++) {
    const id = stored[i];
    if (!byId.has(id) || seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  for (let i = 0; i < sessionIds.length; i++) {
    if (!seen.has(sessionIds[i])) out.push(sessionIds[i]);
  }
  return out;
}

/**
 * Compose the final manual order: reconciled base with every pinned id
 * promoted to the front, keeping relative manual order inside each bucket.
 * @param {string[]} sessionIds - current account session ids (list order).
 * @param {string[]|undefined} stored - previously stored manual order.
 * @param {Set<string>} pinnedSet - pinned ids (may include unknown ids; they drop out).
 * @returns {string[]} the order to hand to the shipped UI.
 */
export function composePinnedOrder(sessionIds, stored, pinnedSet) {
  const base = reconcileOrder(sessionIds, stored);
  const parts = splitPinned(base, pinnedSet);
  return parts.pinned.concat(parts.rest);
}

/**
 * Whether promoting pinned ids changes the given reconciled order at all.
 * @param {string[]} sessionIds - current account session ids (list order).
 * @param {string[]|undefined} stored - previously stored manual order.
 * @param {Set<string>} pinnedSet - pinned ids.
 * @returns {boolean} whether an order write would be a real change.
 */
export function needsOrderWrite(sessionIds, stored, pinnedSet) {
  if (pinnedSet.size === 0) return false;
  const base = reconcileOrder(sessionIds, stored);
  const want = composePinnedOrder(sessionIds, stored, pinnedSet);
  return !sameIds(base, want);
}
