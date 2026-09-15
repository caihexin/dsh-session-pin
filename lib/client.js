/*
 * dsh-session-pin — browser bundle (static client module).
 *
 * Adds pin/favorite (置顶/收藏) to the sidebar session list:
 *   - a star button in each session row's hover actions,
 *   - a persistent star badge on pinned rows,
 *   - pinned sessions promoted to the front of the shipped session order,
 *   - durable state on the host (JSON file) with a localStorage mirror and
 *     live cross-tab sync via `storage` events,
 *   - a settings section listing pins with bulk unpin.
 *
 * Integration model (verified against the shipped @deepseek-ai client-ui-*
 * bundles): session rows are `div[class*="sessionRow"]` whose React fiber
 * props carry `node.id` / `group.key` / `setSessionOrder` +
 * `sessionOrderByAccount` — the shipped manual order, persisted by the
 * workspace view store. The display always renders
 * `reconciledSessionOrder(ids, storedOrder)`, so writing the composed order
 * through the shipped action surfaces pins at the front in BOTH the default
 * ("updated", where fresh-activity rows promote themselves) and "manual"
 * modes. We never replace those components.
 *
 * The shared block below is inlined from lib/shared.js (single source of
 * truth for host + browser); scripts/parity.mjs guards the drift.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-pin",
	factory: (require) => {
		const module = { exports: {} };
		const React = require("react");

		// ================= shared block (sync with lib/shared.js) ==========
		const PLUGIN_ID = "dsh-session-pin";
		const API_PATH = "/api/" + PLUGIN_ID;
		const API_GET = API_PATH + "/pins";
		const API_SET = API_PATH + "/set";
		/** localStorage mirror key (cross-tab channel + instant first paint). */
		const LS_KEY = "dsh.session.pin.v1";
		/**
		 * Order account of the hierarchy-free flat Session list. The shipped
		 * workspace bundle stores that list's order under this exact key, while
		 * the grouped tree uses a workspace id per group ("" when ungrouped).
		 */
		const FLAT_SESSION_ORDER_KEY = "__flat_session_order__";
		const MUTATE_DEBOUNCE_MS = 60;
		const SCAN_INTERVAL_MS = 4000;
		const MAX_ROWS = 2000;

		function sameIds(a, b) {
			if (a.length !== b.length) return false;
			for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
			return true;
		}
		function splitPinned(order, pinnedSet) {
			const pinned = [];
			const rest = [];
			for (let i = 0; i < order.length; i++) {
				if (pinnedSet.has(order[i])) pinned.push(order[i]);
				else rest.push(order[i]);
			}
			return { pinned: pinned, rest: rest };
		}
		function reconcileOrder(sessionIds, stored) {
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
		function composePinnedOrder(sessionIds, stored, pinnedSet) {
			const base = reconcileOrder(sessionIds, stored);
			const parts = splitPinned(base, pinnedSet);
			return parts.pinned.concat(parts.rest);
		}
		function needsOrderWrite(sessionIds, stored, pinnedSet) {
			if (pinnedSet.size === 0) return false;
			const base = reconcileOrder(sessionIds, stored);
			const want = composePinnedOrder(sessionIds, stored, pinnedSet);
			return !sameIds(base, want);
		}
		// =====================================================================

		// ---- module state (single source in this browser tab) --------------
		/** @type {Map<string, {pinnedAt: number}>} */
		const pins = new Map();
		/** @type {Map<string, string>} row titles seen during decoration (settings display). */
		const titleById = new Map();
		const listeners = new Set();
		/** Bumps on every local pin mutation so a slow initial GET cannot clobber fresher state. */
		let mutationSeq = 0;

		function notify() {
			for (const fn of listeners) {
				try { fn(); } catch {}
			}
			// Repaint the rows right away (decorateRow is the only writer of the
			// star/badge state); without this the glyph would wait for the next
			// mutation-driven scan.
			schedule();
		}
		function subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		}
		function isPinned(id) {
			return pins.has(id);
		}
		function pinnedSet() {
			return new Set(pins.keys());
		}

		function pinsToPlain() {
			const out = {};
			for (const [id, v] of pins) out[id] = { pinned: true, pinnedAt: v.pinnedAt || 0 };
			return out;
		}
		function pinsFromPlain(doc) {
			const next = new Map();
			if (doc && doc.pins && typeof doc.pins === "object") {
				for (const [id, v] of Object.entries(doc.pins)) {
					if (typeof id !== "string" || id === "" || !v || v.pinned === false) continue;
					next.set(id, { pinnedAt: typeof v.pinnedAt === "number" ? v.pinnedAt : 0 });
				}
			}
			return next;
		}
		function readLocal() {
			try {
				const raw = localStorage.getItem(LS_KEY);
				if (!raw) return;
				const next = pinsFromPlain(JSON.parse(raw));
				pins.clear();
				for (const [k, v] of next) pins.set(k, v);
			} catch {}
		}
		function writeLocal() {
			try {
				localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, pins: pinsToPlain() }));
			} catch {}
		}

		/**
		 * Toggle one pin: optimistic local update, then persist to the host.
		 * @param {string} id - session id.
		 * @param {boolean} pinned - desired state.
		 */
		function setPin(id, pinned) {
			if (pinned) {
				if (!pins.has(id)) pins.set(id, { pinnedAt: Date.now() });
			} else {
				pins.delete(id);
			}
			mutationSeq++;
			const seqAtSet = mutationSeq;
			writeLocal();
			notify();
			fetch(API_SET, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: id, pinned: pinned }),
			})
				.then((r) => (r.ok ? r.json() : null))
				.then((doc) => {
					if (!doc || !doc.pins || mutationSeq !== seqAtSet) return;
					const next = pinsFromPlain(doc);
					pins.clear();
					for (const [k, v] of next) pins.set(k, v);
					writeLocal();
					notify();
				})
				.catch(() => {});
		}

		// ---- locale helper --------------------------------------------------
		function L(zh, en) {
			const lang = ((typeof document !== "undefined" && document.documentElement.lang) ||
				(typeof navigator !== "undefined" && navigator.language) || "en").toLowerCase();
			return lang.indexOf("zh") === 0 ? zh : en;
		}

		// ---- DOM integration -------------------------------------------------
		const ROW_SEL = '[class*="sessionRow"]';
		const STAR_OUTLINE =
			'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2.2l1.7 3.7 4 .5-3 2.8.8 4L8 11.3 4.5 13.2l.8-4-3-2.8 4-.5z"/></svg>';
		const STAR_FILLED =
			'<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1.6l1.9 4.1 4.5.6-3.3 3 .9 4.5L8 11.5l-4 2.3.9-4.5-3.3-3 4.5-.6z"/></svg>';

		function reactFiberKey(el) {
			for (const key in el) if (key.indexOf("__reactFiber$") === 0) return key;
			return null;
		}
		/**
		 * Walk up the React fiber from a DOM element until a memoizedProps
		 * passes the test (the shipped components' props carry the facts we
		 * need: node identity, group key, order-store actions).
		 * @param {Element|null} el - DOM element.
		 * @param {(props: any) => boolean} test - predicate.
		 * @returns {any|null} the first matching props object.
		 */
		function findProps(el, test) {
			if (!el) return null;
			const key = reactFiberKey(el);
			if (!key) return null;
			let fiber = el[key];
			let hops = 0;
			while (fiber && hops < 60) {
				const props = fiber.memoizedProps;
				if (props && test(props)) return props;
				fiber = fiber.return;
				hops++;
			}
			return null;
		}
		/**
		 * The session node behind a row element (id/title).
		 * @param {Element|null} el - row element.
		 * @returns {{id: string, title?: string}|null} the node.
		 */
		function rowNode(el) {
			const props = findProps(el, (p) => p && p.node && typeof p.node.id === "string");
			return props ? props.node : null;
		}
		/**
		 * The order-store actions reachable from a row element.
		 * @param {Element|null} el - row element.
		 * @returns {{setSessionOrder: (key: string, order: string[]) => void, sessionOrderByAccount: Record<string, string[]>, workspaces?: any[]}|null} the face.
		 */
		function orderFace(el) {
			return findProps(
				el,
				(p) => p && typeof p.setSessionOrder === "function" && p.sessionOrderByAccount && typeof p.sessionOrderByAccount === "object",
			);
		}
		/**
		 * Resolve the store bucket a session id is filed under. The grouped tree
		 * hands its `workspaces` array to the same component that owns the order
		 * actions (each workspace is one bucket, keyed by `workspaceId`, with ""
		 * for the ungrouped group); the hierarchy-free flat list passes no
		 * workspaces and keeps its whole order under the shipped flat key.
		 * @param {any} face - props carrying the order actions.
		 * @returns {(id: string) => string} id -> account key.
		 */
		function accountKeyFor(face) {
			if (!Array.isArray(face.workspaces)) return () => FLAT_SESSION_ORDER_KEY;
			const bucket = new Map();
			for (const w of face.workspaces) {
				if (!w || !Array.isArray(w.sessionIds)) continue;
				const key = typeof w.workspaceId === "string" ? w.workspaceId : "";
				for (const id of w.sessionIds) bucket.set(id, key);
			}
			return (id) => (bucket.has(id) ? bucket.get(id) : "");
		}

		/**
		 * Bring one row's pin affordances up to date.
		 * @param {Element} el - session row element.
		 */
		function decorateRow(el) {
			const node = rowNode(el);
			if (!node) return;
			const id = node.id;
			if (typeof node.title === "string" && node.title) titleById.set(id, node.title);
			const pinned = isPinned(id);

			let badge = el.querySelector(":scope > .dsh-pin-badge");
			if (pinned && !badge) {
				badge = document.createElement("span");
				badge.className = "dsh-pin-badge";
				badge.innerHTML = STAR_FILLED;
				badge.setAttribute("aria-hidden", "true");
				badge.title = L("已置顶", "Pinned");
				el.insertBefore(badge, el.firstChild);
			} else if (!pinned && badge) {
				badge.remove();
			}

			const actions = el.querySelector('[class*="rowActions"]');
			if (actions) {
				let btn = actions.querySelector(":scope > .dsh-pin-btn");
				if (!btn) {
					btn = document.createElement("button");
					btn.type = "button";
					btn.className = "dsh-pin-btn";
					btn.setAttribute("draggable", "false");
					btn.setAttribute("data-dsh-pin", "1");
					actions.insertBefore(btn, actions.firstChild);
				}
				btn.dataset.pinned = pinned ? "true" : "false";
				// Rewrite the glyph ONLY on a real state change. Comparing
				// innerHTML against the template never matches (the browser
				// serialises <path/> as <path></path>), so the old check rewrote
				// the subtree on every scan — and when a rewrite landed between
				// mousedown and mouseup the browser suppressed the click
				// outright (the mouseup target was a fresh node). Track the
				// rendered state instead of the markup.
				const want = pinned ? "1" : "0";
				if (btn.dataset.pinState !== want) {
					btn.dataset.pinState = want;
					btn.innerHTML = pinned ? STAR_FILLED : STAR_OUTLINE;
				}
				const label = pinned ? L("取消置顶", "Unpin") : L("置顶", "Pin");
				if (btn.title !== label) btn.title = label;
				if (btn.getAttribute("aria-label") !== label) btn.setAttribute("aria-label", label);
				btn.setAttribute("aria-pressed", pinned ? "true" : "false");
			}
		}

		/**
		 * Promote every pinned session to the front of its account's stored
		 * order by writing through the shipped store action.
		 * @param {Element[]} rows - current session row elements.
		 */
		function syncOrder(rows) {
			if (pins.size === 0) return;
			let face = null;
			for (const el of rows) {
				face = orderFace(el);
				if (face) break;
			}
			if (!face) return;
			const keyFor = accountKeyFor(face);
			const groups = new Map();
			for (const el of rows) {
				const node = rowNode(el);
				if (!node) continue;
				const key = keyFor(node.id);
				let ids = groups.get(key);
				if (!ids) {
					ids = [];
					groups.set(key, ids);
				}
				if (ids.indexOf(node.id) === -1) ids.push(node.id);
			}
			const set = pinnedSet();
			for (const [key, ids] of groups) {
				const stored = face.sessionOrderByAccount[key];
				if (!needsOrderWrite(ids, stored, set)) continue;
				const want = composePinnedOrder(ids, stored, set);
				// Rows this view does not render (collapsed or filtered siblings)
				// keep their bucket membership instead of being dropped.
				const seen = new Set(ids);
				for (const id of stored || []) if (!seen.has(id)) want.push(id);
				try {
					face.setSessionOrder(key, want);
				} catch {}
			}
		}

		let timer = 0;
		function schedule() {
			if (timer !== 0) return;
			timer = setTimeout(() => {
				timer = 0;
				run();
			}, MUTATE_DEBOUNCE_MS);
		}
		function run() {
			try {
				let rows = document.querySelectorAll(ROW_SEL);
				if (rows.length > MAX_ROWS) rows = Array.prototype.slice.call(rows, 0, MAX_ROWS);
				else rows = Array.prototype.slice.call(rows);
				if (rows.length === 0) return;
				for (const el of rows) decorateRow(el);
				syncOrder(rows);
			} catch (error) {
				console.warn("[" + PLUGIN_ID + "]", error);
			}
		}

		/**
		 * Delegated click for pin buttons (capture phase so the row's own
		 * open-on-click never fires).
		 * @param {MouseEvent} e - click event.
		 */
		function onClick(e) {
			const target = e.target instanceof Element ? e.target : null;
			const btn = target ? target.closest("[data-dsh-pin]") : null;
			if (!btn) return;
			e.stopPropagation();
			e.preventDefault();
			const node = rowNode(btn.closest(ROW_SEL));
			if (node) setPin(node.id, !isPinned(node.id));
		}

		/**
		 * @param {StorageEvent} e - storage event (another tab wrote the mirror).
		 */
		function onStorage(e) {
			if (e.key !== LS_KEY || e.newValue == null) return;
			readLocal();
			notify();
		}

		function ensureStyle() {
			if (document.getElementById("dsh-session-pin-css")) return;
			const style = document.createElement("style");
			style.id = "dsh-session-pin-css";
			style.textContent = [
				".dsh-pin-badge{flex:none;width:14px;height:16px;color:#e8a33d;display:inline-flex;align-items:center;justify-content:center;margin:0 2px}",
				".dsh-pin-btn{cursor:pointer;width:20px;height:20px;color:var(--dsw-alias-label-secondary,#8a8f98);background:none;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}",
				".dsh-pin-btn:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}",
				'.dsh-pin-btn[data-pinned="true"]{color:#e8a33d}',
			].join("\n");
			document.head.appendChild(style);
		}

		// ---- settings section -------------------------------------------------
		/**
		 * Settings page: every pinned session with an unpin affordance.
		 * @param {{ useSessions?: (selector: (state: any) => any) => any }} props - slot props (standard `useSessions` face).
		 * @returns {any} the section element tree.
		 */
		function SettingsSection(props) {
			const setTick = React.useState(0)[1];
			React.useEffect(() => subscribe(() => setTick((t) => t + 1)), []);
			let byId = {};
			try {
				if (typeof props.useSessions === "function") {
					const state = props.useSessions((s) => s);
					byId = (state && state.byId) || {};
				}
			} catch {}
			const entries = [];
			for (const [id, v] of pins) entries.push([id, v.pinnedAt || 0]);
			entries.sort((a, b) => a[1] - b[1]);
			const titleOf = (id) => {
				const s = byId[id];
				return (s && s.title) || titleById.get(id) || id.slice(0, 8) + "…";
			};
			const h = React.createElement;
			const rowStyle = {
				display: "flex", alignItems: "center", gap: "8px", padding: "6px 0",
				borderBottom: "1px solid rgba(128,128,128,.15)", minWidth: 0,
			};
			const titleStyle = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "14px" };
			const unpinStyle = {
				cursor: "pointer", border: "none", background: "none", color: "#e8a33d",
				padding: "2px 4px", borderRadius: "4px", flex: "none", display: "inline-flex", fontSize: "16px", lineHeight: "16px",
			};
			return h(
				"div",
				{ style: { padding: "12px 0", maxWidth: "640px" } },
				h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary,#888)", marginBottom: "12px" } },
					L("点击会话行右侧的星标即可置顶；置顶会话固定排在列表最前，并持久保存在服务器上（跨浏览器、跨重启）。",
						"Click the star on a session row to pin it. Pinned sessions stay at the front of the list and persist on the server (across browsers and restarts).")),
				entries.length === 0
					? h("div", { style: { fontSize: "14px", color: "var(--dsw-alias-label-tertiary,#777)", padding: "8px 0" } },
							L("暂无置顶会话。", "No pinned sessions yet."))
					: h("div", null,
							...entries.map(([id]) =>
								h("div", { key: id, style: rowStyle },
									h("span", { style: { color: "#e8a33d", flex: "none", display: "inline-flex" }, dangerouslySetInnerHTML: { __html: STAR_FILLED } }),
									h("span", { style: titleStyle, title: id }, titleOf(id)),
									h("button", {
										type: "button", style: unpinStyle, title: L("取消置顶", "Unpin"), "aria-label": L("取消置顶", "Unpin"),
										onClick: () => setPin(id, false),
									}, "×"))),
							h("button", {
								type: "button",
								style: { marginTop: "12px", cursor: "pointer", fontSize: "13px", padding: "6px 12px", borderRadius: "6px",
									border: "1px solid rgba(128,128,128,.35)", background: "none", color: "inherit" },
								onClick: () => { for (const id of [...pins.keys()]) setPin(id, false); },
							}, L("全部取消置顶", "Unpin all"))),
			);
		}

		// ---- lifecycle ---------------------------------------------------------
		/**
		 * Plugin entry (static client module contract: apply(ctx)).
		 * @param {any} ctx - the cordis context (declared services: slots).
		 */
		function apply(ctx) {
			try {
				ensureStyle();
				readLocal();
				notify();

				// Host state first (authoritative), but a local mutation made while
				// the request was in flight must not be clobbered by the snapshot.
				const seqAtGet = mutationSeq;
				fetch(API_GET)
					.then((r) => (r.ok ? r.json() : null))
					.then((doc) => {
						if (!doc || !doc.pins || mutationSeq !== seqAtGet) return;
						const next = pinsFromPlain(doc);
						pins.clear();
						for (const [k, v] of next) pins.set(k, v);
						writeLocal();
						notify();
					})
					.catch(() => {});

				const observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
				const scan = setInterval(schedule, SCAN_INTERVAL_MS);
				const unsub = subscribe(schedule);
				document.addEventListener("click", onClick, true);
				window.addEventListener("storage", onStorage);

				// cordis contract: effect(fn) runs fn eagerly and keeps the
				// returned disposer for fiber teardown.
				ctx.effect(() => () => {
					observer.disconnect();
					if (timer !== 0) clearTimeout(timer);
					clearInterval(scan);
					unsub();
					document.removeEventListener("click", onClick, true);
					window.removeEventListener("storage", onStorage);
					const css = document.getElementById("dsh-session-pin-css");
					if (css) css.remove();
					document.querySelectorAll(".dsh-pin-badge").forEach((el) => el.remove());
					document.querySelectorAll(".dsh-pin-btn").forEach((el) => el.remove());
				}, PLUGIN_ID + ": dom");

				// Shipped register pattern: inject(key, callback) hands the
				// callback to ctx.effect (invoked with no arguments); register
				// is reached through the ctx closure, exactly like the in-box
				// plugins (ui-settings-plugins does the same).
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register({ name: "settings.section", id: "session-pin", order: 120, label: () => L("会话置顶", "Pinned Sessions") }, SettingsSection),
				);

				schedule();
			} catch (error) {
				console.error("[" + PLUGIN_ID + "] apply failed:", error);
			}
		}

		module.exports.apply = apply;
		module.exports.inject = ["slots"];
		return module.exports;
	},
});
