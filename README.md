**English** | [简体中文](README.zh-CN.md)

# dsh-session-pin

Pin / favourite (置顶 / 收藏) sessions in the DeepSeek Harness Web sidebar.
Pinned sessions stick to the front of their list and the state lives on the
host, so it survives reloads, browsers and restarts.

```
┌ my-workspace ─────────────────────────┐
│ ★ Example: cache warm-up      5min    │  <- pinned: star badge + first
│   New Session                         │
│   Example: flaky deploy       15h     │  <- hover reveals the ★ toggle
│   Example: retrieval tuning   21h     │
└───────────────────────────────────────┘
```

## What it does

| Surface | Behaviour |
| --- | --- |
| Session row (hover) | a ★ button in the row's hover actions pins / unpins |
| Pinned row | a persistent ★ badge before the title |
| List order | pinned rows are promoted to the front of their own account (workspace group, ungrouped bucket, or the flat list) |
| Settings → *Pinned Sessions* | lists every pin with per-row unpin and *Unpin all* |
| Host | `~/.dsh/plugin-data/dsh-session-pin/pins.json`, hourly prune of pins whose session log is gone |

State is written through the **shipped** workspace store action
(`setSessionOrder`) — no component is replaced, and the browser keeps a
`localStorage` mirror that is synced live across tabs via `storage` events.

## HTTP face

| Route | Meaning |
| --- | --- |
| `GET  /api/dsh-session-pin/pins` | full state `{version, pins:{id:{pinned,pinnedAt}}}` |
| `POST /api/dsh-session-pin/set` | `{sessionId, pinned, pinnedAt?}` → refreshed state |
| `POST /api/dsh-session-pin/prune` | `{ids:[…]}` → `{pins:{id:{exists}}}` existence probe |

## Install

Three ways: the self-bootstrapping script from a release, a source checkout,
or the manual steps below.

### From GitHub (recommended)

```bash
mkdir -p ~/dsh-pin && cd ~/dsh-pin
curl -fsSLO https://github.com/caihexin/dsh-session-pin/releases/latest/download/install-dsh-session-pin.sh
bash install-dsh-session-pin.sh --dry-run          # show what it will do
bash install-dsh-session-pin.sh --profile web      # download + sha256 + install
# restart the DSH Web surface, then:
curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins     # {"version":1,"pins":{}}
```

One-liner form:

```bash
curl -fsSL https://github.com/caihexin/dsh-session-pin/releases/latest/download/install-dsh-session-pin.sh | bash -s -- --profile web
```

### From source

```bash
git clone https://github.com/caihexin/dsh-session-pin.git
cd dsh-session-pin
npm test                                                      # 13 checks
bash dist/install-dsh-session-pin.sh --from . --profile web    # install from the checkout
```

### Air-gapped / intranet mirror

If the machine cannot reach github.com, point the same installer at any HTTP mirror that
serves the four release files (`install-*-.sh`, `*.tar.gz`, `*.tar.gz.sha256`, `INSTALL-README-*.md`):

```bash
bash install-dsh-session-pin.sh --base-url http://<mirror>/exchange/dsh --profile web
```

Or carry the tarball over and unpack it (no network at all):

```bash
tar -xzf dsh-session-pin-0.1.0.tar.gz && cd dsh-session-pin-0.1.0
bash install.sh --profile web
```

Full manual install, uninstall and troubleshooting:
[`docs/install-and-deploy.en.md`](docs/install-and-deploy.en.md) — also mirrored as
`INSTALL-README-dsh-session-pin.md` next to the tarball on a mirror, and shipped inside
the release. Cutting a release: [`docs/publishing-guide.en.md`](docs/publishing-guide.en.md).
中文文档：[`README.zh-CN.md`](README.zh-CN.md)、[`docs/install-and-deploy.zh-CN.md`](docs/install-and-deploy.zh-CN.md)、
[`docs/publishing-guide.zh-CN.md`](docs/publishing-guide.zh-CN.md).

### Manual

The package is a DSH **bundle**: it ships a host half (`lib/index.js`), a browser
half (`lib/client.js`) reached through `exports["./client"]`, and a loader patch
(`cordis.patch.yml`) that mounts the host entry.

```bash
# 1. make it resolvable from the profile and list it as a bundle layer
cd ~/.dsh/profiles/web
mkdir -p node_modules/dsh-session-pin
tar cf - -C /path/to/dsh-session-pin package.json cordis.patch.yml lib \
  | tar xf - -C node_modules/dsh-session-pin
python3 - <<'PY'
import json, collections
p = "package.json"
d = json.load(open(p), object_pairs_hook=collections.OrderedDict)
d["dependencies"]["dsh-session-pin"] = "file:/path/to/dsh-session-pin"
d["dsh"]["profile"]["bundles"].append("dsh-session-pin")
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY

# 2. restart the web surface (smoke-first, never kill-then-start)
~/bin/restart-dsh-web.sh          # if present in this installation
```

Do **not** also add a manual `insert` for `dsh-session-pin` to the profile's own
`cordis.patch.yml`: the bundle patch already inserts it, and a second one fails
boot with `duplicate loader entry id`.

After changing `lib/client.js` no restart is needed — the bundle is served from
disk at `/plugins/dsh-session-pin/client.js` with `cache-control: no-cache`, so a
page refresh picks it up. A `package.json` change (e.g. `immediately`) needs a
restart because the boot manifest is composed at boot.

### Release build

```bash
bash dist/build-release.sh    # → dist/*.tar.gz + .sha256 + exchange INSTALL-README
```

## Tests

```bash
npm test        # node --test test/*.test.mjs  (Node 22 rejects a bare dir arg)
```

`test/smoke.test.mjs` covers the shared order helpers, the host HTTP handlers and
state-file lifecycle, and runs the browser bundle against a fake DOM that
emulates the shipped React fiber props (`node` on the row fiber, order actions +
`workspaces` on an ancestor) and browser-faithful `innerHTML` serialisation.

## Two traps this package already paid for

1. **Never rewrite a foreign node to "refresh" it.** `btn.innerHTML !== template`
   is *always* true — the browser serialises `<path/>` as `<path></path>`. The
   old check re-rendered the button's subtree on every scan pass, and a pass
   landing between `mousedown` and `mouseup` made the browser drop the `click`
   entirely: the star was visible, clicking did nothing. Track the rendered
   state (a dataset flag), not the markup.
2. **The order bucket is not the row's own prop.** In the grouped tree the row
   fiber carries only the session `node`; the component owning `setSessionOrder`
   is an ancestor and it carries `workspaces`, whose `workspaceId` is the bucket
   key (ungrouped rows use `""`). The hierarchy-free flat list passes no
   `workspaces` and files everything under the shipped key
   `"__flat_session_order__"`. Writing to the wrong key silently "works" but
   nothing moves.
