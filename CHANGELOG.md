# Changelog

All notable changes to `dsh-session-pin` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-15

First release: pin / favorite sessions in the DSH Web sidebar.

### Added

- ★ pin button on every session row (hover action area), rendered through the
  shipped `sessionRowActions` slot — no component replacement.
- Persistent star badge on pinned rows.
- Pinned sessions are promoted to the front of their account bucket
  (workspace group in the grouped view, the whole list in the flat view).
- Host half: `GET/POST /api/dsh-session-pin/{pins,set,prune}` with state in
  `$DSH_HOME/plugin-data/dsh-session-pin/pins.json`, plus an hourly prune of
  pins whose session no longer exists.
- Settings → **Pinned Sessions** section: per-item unpin and "Unpin all".
- Cross-tab sync via the `storage` event; browser-side `localStorage` mirror is
  seeded once from host state.
- 13 regression tests (`node --test test/*.test.mjs`).

### Fixed

- **Star rendered but clicks did nothing.** The redraw guard compared
  `btn.innerHTML` against a template, but browsers serialize the self-closing
  `<path/>` as `<path></path>`, so the strings never matched and the button
  subtree was rebuilt on every scan; when a rebuild landed between `mousedown`
  and `mouseup` the browser suppressed the `click` entirely. The guard is now
  `dataset.pinState`, and redraws happen only on real state changes.
- **Pinned sessions were not promoted.** The account-bucket key was read from
  the row fiber's `props.group`, which does not exist there (the row fiber
  carries `node`). The key now comes from the ancestor order face
  (`workspaces[].workspaceId`, `""` for ungrouped,
  `__flat_session_order__` for the flat list), so `setSessionOrder` writes to
  the bucket that is actually rendered.

### Known limitations

- Unpinning removes the badge and the state, but does not restore the session's
  previous position — pinning writes the shipped explicit order, and unpinning
  does not rewrite history.
- Host state is read from disk once and cached in memory; external edits to
  `pins.json` are ignored until restart. Use the API instead.
