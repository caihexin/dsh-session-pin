[English](install-and-deploy.en.md) | **[简体中文](install-and-deploy.zh-CN.md)** | [← Back to README](../README.md)

# dsh-session-pin — installation & deployment

**Plugin**: `dsh-session-pin` 0.1.0 — pin / favorite sessions in the DSH Web sidebar.
**Distribution**: GitHub Releases (<https://github.com/caihexin/dsh-session-pin/releases>) by default.
Intranet/air-gapped installs point the same installer at a local mirror with `--base-url`.
**Shape**: a DSH bundle (host half + browser half + loader patch), no npm dependencies (Node built-ins only).

---

## 1. What it does

| Where | Behaviour |
| --- | --- |
| Session row (hover) | A ★ button appears in the row's action area; one click pins / unpins |
| Pinned rows | A persistent ★ badge in front of the title |
| List order | Pinned sessions rise to the front of **their own account bucket** (workspace group in the grouped view, the whole list in the flat view) |
| Settings → *Pinned Sessions* | Lists every pin, with per-item unpin and "Unpin all" |
| Host half | State in `$DSH_HOME/plugin-data/dsh-session-pin/pins.json`, with an hourly prune of pins for deleted sessions |

Reordering goes through the shipped **`setSessionOrder`** (the same state the official drag-and-drop
uses); no shipped component is replaced. The browser also keeps a `localStorage` mirror and syncs
across tabs through the `storage` event.

```
┌ my-workspace ─────────────────────────┐
│ ★ Example: cache warm-up      5min    │  <- pinned: star badge + first
│   New Session                         │
│   Example: flaky deploy       15h     │  <- hover reveals the ★ toggle
│   Example: retrieval tuning   21h     │
└───────────────────────────────────────┘
```

## 2. Requirements

| Item | Requirement |
| --- | --- |
| DSH | Any profile with the Web surface (default `web`); `@deepseek-ai/dsh-base` + `dsh-web-app` already in its bundles |
| Node | ≥ 18 (the self-test uses `node --test`; running the plugin itself only needs DSH's own runtime) |
| Installer | `bash` + `curl` + `tar` + `sha256sum` + `python3` (to edit the profile manifest) |
| Network | Online install needs to reach GitHub (or your mirror); air-gapped hosts can use the bundled `install.sh` |

## 3. Install (recommended: the self-bootstrapping script)

```bash
# 0) Air-gapped / mirror users only: point BASE_URL at your mirror.
#    Public users skip this — the script defaults to the GitHub release.
EXCHANGE=https://github.com/caihexin/dsh-session-pin/releases/latest/download

# 1) Download the script
mkdir -p ~/dsh-pin && cd ~/dsh-pin
curl -fsSLO "$EXCHANGE/install-dsh-session-pin.sh"

# 2) Dry run first: shows every action, changes nothing
bash install-dsh-session-pin.sh --dry-run

# 3) Real install: download + sha256 verify + install into the web profile
bash install-dsh-session-pin.sh --profile web

# 4) Restart DSH, then verify
curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins     # expect {"version":1,"pins":{}}
```

The installer prints the source directory, install directory, the manifest backup path and the restart
commands. Add `--restart` to let it restart for you (it uses `~/bin/restart-dsh-web.sh` when present,
otherwise `systemctl --user restart dsh-web.service`).

Common flags:

| Flag | Effect |
| --- | --- |
| `--profile <name>` | Which profile to install into (default `web`) |
| `--dsh-home <dir>` | DSH home (default `$DSH_HOME` or `~/.dsh`) |
| `--dest <dir>` | Where to keep the source (default `~/dsh-session-pin`) |
| `--from <dir>` | Install from an already-unpacked directory, no download |
| `--base-url <url>` | Distribution base URL (default: the GitHub release) |
| `--port <n>` | Port used for the post-install check (default 3080) |
| `--lang en\|zh` | Force message language (default: auto-detected from `$LC_ALL`/`$LC_MESSAGES`/`$LANG`) |
| `--dry-run` / `--no-test` / `--keep-work` | Only print actions / skip the self-test / keep the temp dir |

## 4. Install (manual, four steps — same as the script)

```bash
PROFILE_DIR=~/.dsh/profiles/web
SRC=~/dsh-session-pin                      # unpacked release directory

# 1) Put the package into the profile's node_modules (copy, not a symlink)
mkdir -p "$PROFILE_DIR/node_modules/dsh-session-pin"
cp -a "$SRC"/{package.json,cordis.patch.yml,lib,README.md,docs} \
      "$PROFILE_DIR/node_modules/dsh-session-pin/"

# 2) Register it as a bundle (both dependencies and dsh.profile.bundles)
python3 - "$PROFILE_DIR/package.json" "$SRC" <<'PY'
import json, sys, collections
path, src = sys.argv[1], sys.argv[2]
d = json.load(open(path, encoding="utf8"), object_pairs_hook=collections.OrderedDict)
d.setdefault("dependencies", collections.OrderedDict())["dsh-session-pin"] = "file:" + src
b = d.setdefault("dsh", collections.OrderedDict()).setdefault("profile", collections.OrderedDict()).setdefault("bundles", [])
if "dsh-session-pin" not in b:
    b.append("dsh-session-pin")
json.dump(d, open(path, "w", encoding="utf8"), indent=2, ensure_ascii=False)
open(path, "a").write("\n")
print("bundles =", ", ".join(b))
PY

# 3) Restart (the bundle list is only assembled at boot)
systemctl --user restart dsh-web.service     # or ~/bin/restart-dsh-web.sh

# 4) Verify
curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins
```

> ⚠️ Do **not** add your own `insert` entry with `id: dsh-session-pin` to the profile's
> `cordis.patch.yml`. The bundle ships that patch, and a second one fails boot with
> `duplicate loader entry id: dsh-session-pin`.

## 5. Acceptance checklist

| Check | Command / action | Expected |
| --- | --- | --- |
| Host half loaded | `curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins` | `{"version":1,"pins":{}}` |
| Browser half loaded | After a refresh, in the console: `document.querySelectorAll('.dsh-pin-btn').length` | > 0 |
| Pinning works | Hover any non-first row → click ★ | Badge appears and the row moves to the front of its group |
| Unpinning works | Click that row's ★ again | Badge disappears |
| Persistence | Reload the page | The pin is still there (host state wins) |
| Settings section | Settings → *Pinned Sessions* | The pinned list + "Unpin all" |

## 6. Uninstall

```bash
PROFILE_DIR=~/.dsh/profiles/web
rm -rf "$PROFILE_DIR/node_modules/dsh-session-pin"
python3 - "$PROFILE_DIR/package.json" <<'PY'
import json, sys, collections
p = sys.argv[1]
d = json.load(open(p, encoding="utf8"), object_pairs_hook=collections.OrderedDict)
d.get("dependencies", {}).pop("dsh-session-pin", None)
b = (d.get("dsh", {}).get("profile", {}) or {}).get("bundles")
if isinstance(b, list) and "dsh-session-pin" in b:
    b.remove("dsh-session-pin")
json.dump(d, open(p, "w", encoding="utf8"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
PY
rm -rf ~/.dsh/plugin-data/dsh-session-pin      # add this to drop the pins too
# restart DSH for it to take effect
```

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Boot fails: `duplicate loader entry id: dsh-session-pin` | Both the profile's `cordis.patch.yml` and the bundle insert the entry. Remove the manual `insert` from the profile. |
| `plugin tree failed to load` | Check the plugin name in the boot log; usually an incomplete `node_modules/dsh-session-pin` (missing `lib/`, or `package.json` without `dsh.bundle`). Re-unpack over it. |
| API 404 | Not restarted (the bundle list is assembled at boot), or the host half did not load (look for `[dsh-session-pin]` in the boot log). |
| **The star is there but clicks do nothing** | The browser is still running an old bundle. **Hard refresh** (Ctrl/Cmd+Shift+R). 0.1.0 fixes two real bugs (see §9); with an old bundle the browser swallows the click. |
| Pinned, but not at the front | Versions before 0.1.0 wrote the order into the wrong account bucket (the ungrouped one). Upgrade to 0.1.0 and hard-refresh. |
| Editing `pins.json` has no effect | The host caches the file in memory after first read. Use the API (`POST /api/dsh-session-pin/set`) or restart DSH. |
| No *Pinned Sessions* section | The browser half did not load (same as "API 404"), or the profile does not mount `dsh-client-ui-settings`. |
| Where did it install? | The installer prints three paths; or `ls ~/.dsh/profiles/web/node_modules/dsh-session-pin`. |

## 8. Files and paths

| Path | Purpose |
| --- | --- |
| `~/.dsh/profiles/<profile>/node_modules/dsh-session-pin/` | Install location (DSH resolves the bundle from here) |
| `~/dsh-session-pin/` | Source directory (installer default; change with `--dest`) |
| `~/.dsh/profiles/<profile>/package.json` | Registered `dependencies` + `dsh.profile.bundles` (backed up to `*.dsh-session-pin.bak-<timestamp>` before writing) |
| `~/.dsh/plugin-data/dsh-session-pin/pins.json` | Pin state (`{version, pins:{id:{pinned,pinnedAt}}}`) |
| `/plugins/dsh-session-pin/client.js` | HTTP entry of the browser half (`cache-control: no-cache`) |
| `/api/dsh-session-pin/{pins,set,prune}` | HTTP surface of the host half |

## 9. The two real bugs fixed in 0.1.0 (why upgrade)

1. **"The star is there but clicking does nothing."** The old redraw guard compared
   `btn.innerHTML` against a template, but browsers serialize the self-closing `<path/>` as
   `<path></path>`, so the strings never matched and the button subtree was rebuilt on every scan.
   When a rebuild landed between `mousedown` and `mouseup`, the browser suppressed the `click`
   entirely. The guard is now `dataset.pinState`, and redraws happen only on real state changes.
2. **"Pinned sessions are not promoted."** The old code read `props.group.key` off the row fibre,
   where no `group` exists (the row fibre carries `node`). The account-bucket key belongs to the
   **ancestor** order face: `workspaces[].workspaceId` (`""` for ungrouped,
   `__flat_session_order__` for the flat list). Writing to the wrong bucket leaves the order unchanged.

`test/smoke.test.mjs` covers both (13 checks); the "glyph is not re-rendered" case is red on the
pre-0.1.0 implementation.

## 10. Copy-paste instruction for another DSH agent

> Download `install-dsh-session-pin.sh` from
> `https://github.com/caihexin/dsh-session-pin/releases/latest/download` (intranet hosts: use your
> mirror instead), run `bash install-dsh-session-pin.sh --dry-run` and then
> `bash install-dsh-session-pin.sh --profile web` (it downloads and sha256-verifies the release),
> then restart the DSH Web surface. Verify with
> `curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins` (expect `{"version":1,"pins":{}}`), and
> report the install paths plus the plugin log lines from before and after the restart.

---

**Checksums**: see `dsh-session-pin-0.1.0.tar.gz.sha256` next to the tarball (the installer verifies it
automatically). Packaging is **reproducible**: `bash dist/build-release.sh` yields identical bytes and
sha256 for identical content on the same machine, so third parties can rebuild and compare.
**Version**: 0.1.0 | **License**: MIT
