# Contributing

Thanks for improving `dsh-session-pin`.

## Ground rules

- **Additive only.** The plugin must not replace shipped components. Both halves
  hook existing seams: the host uses a loader patch (`cordis.patch.yml`), the
  browser half renders into the shipped `sessionRowActions` slot and calls the
  shipped `setSessionOrder` / settings-section APIs. If a change requires
  monkey-patching a component, it is the wrong change.
- **No runtime dependencies.** Use Node built-ins only (`node:http`,
  `node:fs`, ...). The bundle must stay installable in an air-gapped intranet.
- **No build step.** `lib/*.js` is shipped as-is; keep it readable.

## Before you open a PR

```bash
npm test        # node --test test/*.test.mjs — must be green
```

Add a test for every behaviour change. Bug-fix PRs should include a test that
**fails on the previous code** (see `test/smoke.test.mjs`: the "glyph is not
re-rendered" case is red on the pre-0.1.0 implementation).

If you touch `lib/client.js` by hand on a live installation, no restart is
needed — the bundle is served from disk with `cache-control: no-cache`, so a
page refresh picks it up. A `package.json` change (e.g. `dsh.client.immediately`)
needs a DSH restart because the boot manifest is composed at boot.

## Compatibility

The browser half reads fibre props off the shipped session-list components
(`node`, `workspaces[].workspaceId`, `orderKey`). DSH is pre-1.0; when a DSH
upgrade changes those shapes, the bootstrap guard degrades to a silent no-op
rather than throwing. Please re-verify against the new version and record the
tested DSH version in the PR description.

## Reporting bugs

Include: DSH version, install path, browser, what you clicked, what you expected,
what happened, and the output of

```bash
curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins
```
