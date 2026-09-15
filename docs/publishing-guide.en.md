[English](publishing-guide.en.md) | **[简体中文](publishing-guide.zh-CN.md)** | [← Back to README](../README.md)

# Publishing guide (releases, GitHub, npm, mirrors)

This is the **generic** release documentation: anyone who forks this repository can follow it.
Intranet-specific hosts and mirror addresses are deliberately not in this repository — the
installing side is documented in `install-and-deploy.en.md`.

## 0. Distribution channels

| Channel | How people get it | What it needs |
| --- | --- | --- |
| **GitHub (source + Release assets)** | `git clone`, or the self-bootstrapping script from the Release | read: nothing; push: a PAT or an SSH key |
| **npm (optional)** | `npm i dsh-session-pin` or `dsh plugin add dsh-session-pin` | an npmjs token |
| **Internal mirror (optional)** | a read-only HTTP exchange site; used exactly like a GitHub Release | the site address, provided by your team |

All three publish the same package: `dsh-session-pin-<version>.tar.gz` + `.sha256` +
`install-dsh-session-pin.sh` + the generated distribution page.

## 1. Release routine

```bash
npm test                                   # must be green (node --test, 13 checks)
# bump package.json "version", add a CHANGELOG.md section
bash dist/build-release.sh                 # -> dist/*.tar.gz + .sha256 + INSTALL-README-*.md
git add -A && git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "dsh-session-pin X.Y.Z"
git push && git push --tags                # the tag push triggers CI packaging + Release assets
```

`build-release.sh` does four things: runs the tests → builds `dsh-session-pin-<version>.tar.gz`
(including `install.sh`, `docs/`, `test/`) → writes the `.sha256` sidecar → generates the
distribution page `INSTALL-README-*.md` from the packaged docs (with the sha256 embedded).

The distribution URL defaults to this repository's Release and can be overridden (for example to
point at an internal mirror):

```bash
BASE_URL=http://<your-mirror>/exchange/dsh bash dist/build-release.sh
```

> ⚠️ Any change to a published artifact — even one README line — means **rebuild and re-upload the
> whole chain**, otherwise the sidecar on the site no longer matches the tarball and the installer
> refuses to install.

### Packaging is reproducible

`build-release.sh` uses
`tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - … | gzip -n -9`, which pins the
file order, timestamps and ownership and stops gzip from recording a name/timestamp. On the **same
machine**, two builds of identical content therefore produce identical bytes and an identical
sha256 — a third party can rebuild and compare.

One honest caveat: **different gzip implementations/versions can emit different compressed streams**
(measured: local gzip 1.12 vs the GitHub Actions runner's gzip produce different bytes for identical
content). So when comparing across machines, compare the **unpacked content** (`tar -xzf` then
`diff -r`), or check that each channel's sidecar matches that channel's tarball. Plain `tar -czf` is
not even reproducible on one machine (gzip writes the current time into the header).

## 2. Publishing to GitHub

Prepare an identity once (either one):

**A. PAT (Personal Access Token)** — GitHub no longer accepts account passwords for git; the command
line needs a PAT or an SSH key. Go to <https://github.com/settings/tokens> → **Generate new token**:

- **Tokens (classic)**: tick `repo`; keep the expiry short.
- **Fine-grained tokens**: pick the target repository; permissions `Administration: write` (create
  the repo) + `Contents: write` (push).

Hand the token to the machine (never into shell history or a chat log):

```bash
mkdir -p ~/.config/dsh-publish && install -m 600 /dev/null ~/.config/dsh-publish/github-token
read -rs T && printf '%s' "$T" > ~/.config/dsh-publish/github-token && unset T
```

**B. SSH key (hand over no secret at all)** — add the publishing machine's `~/.ssh/id_ed25519.pub`
at <https://github.com/settings/keys>, then:

```bash
bash dist/publish-github.sh --ssh <your-github-login>
```

> If your network needs a proxy to reach `github.com`, export `GITHUB_PROXY=http://<proxy>:<port>`
> first. The script carries the credential only in the URL of that single push — it is not written to
> `.git/config` or to `~/.git-credentials`.

What the script does: verify the identity → create the repository (reuse it if it exists) → configure
the remote → push `main` and every tag. (`--force` overwrites an auto-generated initial commit.)

## 3. Publishing to npm (optional)

DSH's plugin loader resolves bundles from the profile's `node_modules`, so an npm release makes the
official command work:

```bash
read -rs NPM_TOKEN
echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > ~/.npmrc.publish
npm publish --userconfig ~/.npmrc.publish --registry https://registry.npmjs.org/
```

Installing it on another machine:

```bash
dsh plugin --profile web add dsh-session-pin
# then append dsh-session-pin to the profile's dsh.profile.bundles and restart DSH
```

> If your `~/.npmrc` points at a mirror registry, always pass
> `--registry https://registry.npmjs.org/` when publishing.

## 4. Intranet / offline mirrors

A mirror only has to serve the four files over HTTP; installing from it is identical to installing
from a GitHub Release:

```bash
bash dist/install-dsh-session-pin.sh --base-url http://<mirror>/exchange/dsh --profile web
```

Uploading (with `curl -T`):

```bash
BASE=http://<mirror>/exchange/dsh
for f in install-dsh-session-pin.sh INSTALL-README-dsh-session-pin.md \
         dsh-session-pin-0.1.0.tar.gz dsh-session-pin-0.1.0.tar.gz.sha256; do
  curl -fsS -T "dist/$f" "$BASE/$f"
done
# read back and verify: the sidecar on the site must match the tarball on the site
curl -fsSL "$BASE/dsh-session-pin-0.1.0.tar.gz.sha256" -o /tmp/s
curl -fsSL -o /tmp/dsh-session-pin-0.1.0.tar.gz "$BASE/dsh-session-pin-0.1.0.tar.gz"
(cd /tmp && sha256sum -c s)
```

Fully air-gapped hosts (not even the mirror is reachable) can just carry the tarball over:

```bash
tar -xzf dsh-session-pin-0.1.0.tar.gz && cd dsh-session-pin-0.1.0
bash install.sh --profile web
```

## 5. Versioning and compatibility

- DSH is pre-1.0. The browser half reads props off shipped components (`node`,
  `workspaces[].workspaceId`, `orderKey`). After a DSH upgrade, re-run the self-test that ships inside
  the package and note the tested DSH version in the CHANGELOG.
- `test/smoke.test.mjs` ships inside the release, so any installed machine can re-verify with
  `npm test`.
