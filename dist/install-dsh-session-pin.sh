#!/usr/bin/env bash
# ============================================================================
# dsh-session-pin — self-bootstrapping installer / 自举安装脚本
# 一条命令把「DSH Web 侧栏 置顶/收藏」插件装进某个 profile。
# One command to install the "pin / favorite sessions" plugin into a DSH profile.
# ----------------------------------------------------------------------------
# Distribution / 分发地址:
#   https://github.com/caihexin/dsh-session-pin/releases/latest/download   (default)
#   mirror / 内网镜像: pass --base-url http://<mirror>/exchange/dsh
#
# Usage / 用法（新机器上执行）:
#   curl -fsSLO <base-url>/install-dsh-session-pin.sh
#   bash install-dsh-session-pin.sh --help        # 中英双语，按系统语言自动选择
#   bash install-dsh-session-pin.sh --dry-run     # 先看它要做什么（不改文件）
#   bash install-dsh-session-pin.sh --profile web # 正式安装
#   离线 / offline: tar -xzf dsh-session-pin-<v>.tar.gz && cd dsh-session-pin-<v> && bash install.sh
#
# Messages follow $LC_ALL/$LC_MESSAGES/$LANG (English default, Chinese for zh_*);
# override with --lang en|zh.  输出语言随系统自动切换，也可 --lang 指定。
# Exit codes: 0 ok | 1 usage/environment | 2 download/verification | 3 manual restart needed
# ============================================================================
set -euo pipefail

PLUGIN="dsh-session-pin"
VERSION="0.1.0"
TARBALL="${PLUGIN}-${VERSION}.tar.gz"
BASE_URL="${BASE_URL:-https://github.com/caihexin/dsh-session-pin/releases/latest/download}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-web}"
DEST="${DEST:-$HOME/$PLUGIN}"
BASE_URL_SET=0
FROM=""
DRY_RUN=0
KEEP=0
VERIFY=1
TEST=1
RESTART=0
PORT=3080

# ---- 文案：中英双语，按系统语言自动选择（--lang 可强制）---------------------
LANG_OPT=""
detect_lang() {
  local l="${LANG_OPT:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}"
  case "$l" in
    zh*|*zh_*|*zh-*|*_CN*|*_cn*) printf 'zh' ;;
    '') printf 'en' ;;
    *) printf 'en' ;;
  esac
}
declare -A MSG
set_messages() {
  if [ "$LANG_ACTIVE" = "zh" ]; then
    MSG[bad_arg]='未知参数: %s（--help 看用法）'
    MSG[need_profile]='--profile 不能为空'
    MSG[need_python3]='缺少 python3（用于安全改写 profile 的 package.json）'
    MSG[need_tar]='缺少 tar'
    MSG[need_curl]='缺少 curl（离线安装请用 --from <已解包目录>）'
    MSG[offline]='检测到脚本就在发布包内, 走离线安装: %s'
    MSG[target]='目标: profile=%s  dsh_home=%s  源码目录=%s'
    MSG[no_profile_dir]='profile 目录不存在: %s\n  先让该 DSH 用这个 profile 起一次（例如 dsh --profile %s --port %s --no-open），\n  或改用 --dsh-home 指向真正的 DSH 主目录。'
    MSG[no_profile_manifest]='profile 缺少 package.json: %s'
    MSG[no_from_manifest]='--from 目录里没有 package.json: %s'
    MSG[step1_local]='步骤1/5 使用本地发布包: %s'
    MSG[step1_download]='步骤1/5 下载 %s （%s）'
    MSG[download_failed]='下载失败: %s'
    MSG[sha_failed]='sha256 校验失败（包可能损坏或被篡改）'
    MSG[no_sidecar]='分发站上没有 .sha256 校验文件, 跳过校验'
    MSG[untar_failed]='解包失败'
    MSG[no_stage_dir]='解包后找不到发布包目录'
    MSG[dry_skip_fetch]='      [dry-run] 跳过下载与解包（按 %s 演示后续步骤）'
    MSG[untar_ok]='      解包完成: %s'
    MSG[incomplete]='发布包不完整, 缺少 %s（%s）'
    MSG[step2]='步骤2/5 释放源码到 %s'
    MSG[step3]='步骤3/5 安装插件到 %s'
    MSG[step4]='步骤4/5 登记 bundle: dependencies + dsh.profile.bundles'
    MSG[dry_register]='  [dry-run] 将登记 dependencies.%s=file:%s 与 dsh.profile.bundles += %s'
    MSG[dup_insert_1]='profile 的 cordis.patch.yml 里还有 id: %s 的手动 insert —— 与 bundle 自带的插入重复,'
    MSG[dup_insert_2]='DSH 会以 "duplicate loader entry id" 启动失败。请删掉那段 insert 后重启。'
    MSG[step5_dry]='步骤5/5 [dry-run] 跳过装后自测与重启'
    MSG[step5_test]='步骤5/5 装后自测（node --test）'
    MSG[test_ok]='      自测通过 ✓'
    MSG[test_failed]='自测未通过（插件可能仍可用, 但请把输出发回来: cd %s && node --test test/*.test.mjs）'
    MSG[step5_skip]='步骤5/5 跳过自测（--no-test 或本机没有 node / 包里没有 test/）'
    MSG[install_done]='安装完成 ✓'
    MSG[restart_script]='--restart: 调用 ~/bin/restart-dsh-web.sh'
    MSG[restart_script_fail]='重启脚本返回非 0, 请人工确认'
    MSG[restart_systemd]='--restart: systemctl --user restart dsh-web.service'
    MSG[restart_systemd_fail]='systemctl 返回非 0, 请人工确认'
    MSG[no_restart]='没找到重启脚本或 systemd 单元, 请手动重启 DSH'
    MSG[verify_cmd]='验收: curl -s http://127.0.0.1:%s/api/dsh-session-pin/pins'
    MSG[verify_fail]='验收请求失败, 请确认端口与进程'
  else
    MSG[bad_arg]='unknown argument: %s (see --help)'
    MSG[need_profile]='--profile must not be empty'
    MSG[need_python3]='python3 is required (it rewrites the profile package.json safely)'
    MSG[need_tar]='tar is required'
    MSG[need_curl]='curl is required (use --from <unpacked-dir> for offline installs)'
    MSG[offline]='installer runs inside the release package, using offline mode: %s'
    MSG[target]='target: profile=%s  dsh_home=%s  source=%s'
    MSG[no_profile_dir]='profile directory not found: %s\n  Start that DSH once with this profile (e.g. dsh --profile %s --port %s --no-open),\n  or point --dsh-home at the real DSH home.'
    MSG[no_profile_manifest]='profile has no package.json: %s'
    MSG[no_from_manifest]='no package.json in --from directory: %s'
    MSG[step1_local]='step 1/5 using the local release package: %s'
    MSG[step1_download]='step 1/5 downloading %s (%s)'
    MSG[download_failed]='download failed: %s'
    MSG[sha_failed]='sha256 verification failed (the package is corrupt or tampered with)'
    MSG[no_sidecar]='no .sha256 sidecar on the distribution site, skipping verification'
    MSG[untar_failed]='unpacking failed'
    MSG[no_stage_dir]='no release directory found after unpacking'
    MSG[dry_skip_fetch]='      [dry-run] skipping download and unpack (would use %s)'
    MSG[untar_ok]='      unpacked: %s'
    MSG[incomplete]='release package is incomplete, missing %s (%s)'
    MSG[step2]='step 2/5 placing sources into %s'
    MSG[step3]='step 3/5 installing the plugin into %s'
    MSG[step4]='step 4/5 registering the bundle: dependencies + dsh.profile.bundles'
    MSG[dry_register]='  [dry-run] would register dependencies.%s=file:%s and dsh.profile.bundles += %s'
    MSG[dup_insert_1]='your profile cordis.patch.yml still has a manual insert for id: %s — it duplicates the bundle patch,'
    MSG[dup_insert_2]='so DSH would fail to boot with "duplicate loader entry id". Delete that insert and restart.'
    MSG[step5_dry]='step 5/5 [dry-run] skipping the self-test and restart'
    MSG[step5_test]='step 5/5 post-install self-test (node --test)'
    MSG[test_ok]='      self-test passed ✓'
    MSG[test_failed]='self-test failed (the plugin may still work; please send the output of: cd %s && node --test test/*.test.mjs)'
    MSG[step5_skip]='step 5/5 skipping the self-test (--no-test, no node, or no test/ in the package)'
    MSG[install_done]='install complete ✓'
    MSG[restart_script]='--restart: calling ~/bin/restart-dsh-web.sh'
    MSG[restart_script_fail]='the restart script exited non-zero, please verify manually'
    MSG[restart_systemd]='--restart: systemctl --user restart dsh-web.service'
    MSG[restart_systemd_fail]='systemctl exited non-zero, please verify manually'
    MSG[no_restart]='no restart script or systemd unit found, restart DSH yourself'
    MSG[verify_cmd]='verify: curl -s http://127.0.0.1:%s/api/dsh-session-pin/pins'
    MSG[verify_fail]='verification request failed, check the port and the process'
  fi
}
LANG_ACTIVE="$(detect_lang)"; set_messages
m() { local k="$1"; shift; printf "${MSG[$k]}" "$@"; }

usage() {
  if [ "$LANG_ACTIVE" = "zh" ]; then
    cat <<'U'
dsh-session-pin 自举安装脚本 —— 一条命令把「侧栏置顶/收藏」插件装进某个 DSH profile

用法: bash install-dsh-session-pin.sh [选项]

  --profile <名>     装进哪个 profile（默认 web）
  --dsh-home <目录>  DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --dest <目录>      源码落地目录（默认 ~/dsh-session-pin）
  --base-url <url>   分发地址（默认 GitHub Release；内网镜像或气隙环境改这里）
  --from <目录>      用本地已解包目录安装，不下载不校验
  --port <n>         验收用端口（默认 3080）
  --lang en|zh       输出语言（默认按 $LC_ALL/$LC_MESSAGES/$LANG 自动判断）
  --dry-run          只打印将要做什么，不改任何文件
  --no-verify        跳过 sha256 校验（不建议）
  --no-test          跳过装后自测
  --keep-work        保留临时目录
  --restart          装完调用重启脚本（~/bin/restart-dsh-web.sh 或 systemctl --user）
  -h, --help         显示本帮助

退出码: 0 成功 | 1 用法或环境错误 | 2 下载或校验失败 | 3 安装完成但需人工重启
U
  else
    cat <<'U'
dsh-session-pin self-bootstrapping installer — one command to install the "pin/favorite sessions"
plugin into a DSH profile.

Usage: bash install-dsh-session-pin.sh [options]

  --profile <name>   profile to install into (default: web)
  --dsh-home <dir>   DSH home (default: $DSH_HOME or ~/.dsh)
  --dest <dir>       where to keep the sources (default: ~/dsh-session-pin)
  --base-url <url>   distribution URL (default: the GitHub release; set this for a mirror)
  --from <dir>       install from an unpacked directory, no download and no verification
  --port <n>         port used for the post-install check (default: 3080)
  --lang en|zh       message language (default: auto from $LC_ALL/$LC_MESSAGES/$LANG)
  --dry-run          print every action without changing anything
  --no-verify        skip the sha256 check (not recommended)
  --no-test          skip the post-install self-test
  --keep-work        keep the temporary directory
  --restart          restart DSH afterwards (~/bin/restart-dsh-web.sh or systemctl --user)
  -h, --help         show this help

Exit codes: 0 ok | 1 usage or environment error | 2 download or verification failed | 3 installed, manual restart required
U
  fi
}

say() { printf '\033[1;36m[%s]\033[0m %s\n' "$PLUGIN" "$*"; }
warn() { printf '\033[1;33m[%s] 注意:\033[0m %s\n' "$PLUGIN" "$*"; }
die() {
  local msg="$1" code="${2:-1}"
  printf '\033[1;31m[%s] ERROR:\033[0m %s\n' "$PLUGIN" "$msg" >&2
  exit "$code"
}
run() { if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --dsh-home) DSH_HOME="${2:?}"; shift 2 ;;
    --dest) DEST="${2:?}"; shift 2 ;;
    --from) FROM="${2:?}"; shift 2 ;;
    --base-url) BASE_URL="${2:?}"; BASE_URL_SET=1; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --keep-work) KEEP=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --no-test) TEST=0; shift ;;
    --restart) RESTART=1; shift ;;
    --lang) LANG_OPT="${2:?}"; LANG_ACTIVE="$(detect_lang)"; set_messages; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "$(m bad_arg "$1")" ;;
  esac
done

LANG_ACTIVE="$(detect_lang)"; set_messages   # 解析完参数后按 --lang 重新定语言
[ -n "$PROFILE" ] || die "$(m need_profile)"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 脚本位于解包后的发布包内 → 自动按离线安装处理
if [ -z "$FROM" ] && [ -f "$SELF_DIR/package.json" ] && grep -q "\"name\": *\"$PLUGIN\"" "$SELF_DIR/package.json" 2>/dev/null; then
  FROM="$SELF_DIR"
  say "$(m offline "$FROM")"
fi

command -v python3 >/dev/null 2>&1 || die "$(m need_python3)"
command -v tar >/dev/null 2>&1 || die "$(m need_tar)"

say "$(m target "$PROFILE" "$DSH_HOME" "$DEST")"
[ -d "$PROFILE_DIR" ] || die "$(m no_profile_dir "$PROFILE_DIR" "$PROFILE" "$PORT")"
[ -f "$PROFILE_DIR/package.json" ] || die "$(m no_profile_manifest "$PROFILE_DIR")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/${PLUGIN}-install.XXXXXX")"
cleanup() { [ "$KEEP" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT

# ---- 1. 取包（在线: 下载 + 校验；离线: 用 --from 目录） --------------------
if [ -n "$FROM" ]; then
  [ -f "$FROM/package.json" ] || die "$(m no_from_manifest "$FROM")"
  SRC="$FROM"
  say "$(m step1_local "$SRC")"
else
  command -v curl >/dev/null 2>&1 || die "$(m need_curl)"
  say "$(m step1_download "$TARBALL" "$BASE_URL")"
  run curl -fsSL -o "$WORK/$TARBALL" "$BASE_URL/$TARBALL" || die "$(m download_failed "$BASE_URL/$TARBALL")" 2
  if [ "$VERIFY" = "1" ]; then
    if run curl -fsSL -o "$WORK/$TARBALL.sha256" "$BASE_URL/$TARBALL.sha256"; then
      run bash -c "cd '$WORK' && sha256sum -c '$TARBALL.sha256'" || die "$(m sha_failed)" 2
    else
      warn "$(m no_sidecar)"
    fi
  else
    warn "--no-verify: 已跳过 sha256 校验"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    SRC="$WORK/${PLUGIN}-${VERSION}"
    say "$(m dry_skip_fetch "$SRC")"
  else
    run tar -xzf "$WORK/$TARBALL" -C "$WORK" || die "$(m untar_failed)" 2
    SRC="$WORK/${PLUGIN}-${VERSION}"
    [ -d "$SRC" ] || SRC="$(find "$WORK" -maxdepth 2 -name package.json -path "*${PLUGIN}*" -printf '%h\n' | head -1)"
    [ -n "$SRC" ] && [ -d "$SRC" ] || die "$(m no_stage_dir)" 2
    say "$(m untar_ok "$SRC")"
  fi
fi

if [ "$DRY_RUN" != "1" ]; then
  for f in package.json cordis.patch.yml lib/index.js lib/client.js; do
    [ -f "$SRC/$f" ] || die "$(m incomplete "$f" "$SRC")"
  done
fi

# ---- 2. 落到稳定源码目录 ---------------------------------------------------
say "$(m step2 "$DEST")"
run mkdir -p "$DEST"
for item in package.json cordis.patch.yml lib test README.md docs; do
  [ -e "$SRC/$item" ] || continue
  run rm -rf "$DEST/$item"
  run cp -a "$SRC/$item" "$DEST/"
done
[ -f "$DEST/lib/index.js" ] && [ -f "$DEST/lib/client.js" ] || [ "$DRY_RUN" = "1" ] || die "源码释放后缺少 lib/*.js"

# ---- 3. 装进 profile 的 node_modules --------------------------------------
TARGET="$PROFILE_DIR/node_modules/$PLUGIN"
say "$(m step3 "$TARGET")"
run mkdir -p "$TARGET"
for item in package.json cordis.patch.yml lib test README.md docs; do
  [ -e "$DEST/$item" ] || continue
  run rm -rf "$TARGET/$item"
  run cp -a "$DEST/$item" "$TARGET/"
done

# ---- 4. 登记到 profile 清单（幂等, 先备份） --------------------------------
say "$(m step4)"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ "$DRY_RUN" != "1" ]; then cp -a "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.$PLUGIN.bak-$STAMP"; fi
if [ "$DRY_RUN" = "1" ]; then
  say "$(m dry_register "$PLUGIN" "$DEST" "$PLUGIN")"
else
run python3 - "$PROFILE_DIR/package.json" "$PLUGIN" "$DEST" <<'PY'
import json, sys, collections
path, name, dest = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf8") as fh:
    doc = json.load(fh, object_pairs_hook=collections.OrderedDict)
doc.setdefault("dependencies", collections.OrderedDict())
doc["dependencies"][name] = "file:" + dest
dsh = doc.setdefault("dsh", collections.OrderedDict())
profile = dsh.setdefault("profile", collections.OrderedDict())
bundles = profile.setdefault("bundles", [])
if name not in bundles:
    bundles.append(name)
with open(path, "w", encoding="utf8") as fh:
    json.dump(doc, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("  dependencies.%s = file:%s" % (name, dest))
print("  dsh.profile.bundles = %s" % ", ".join(bundles))
PY
fi

# 同 id 的重复装载是启动失败的头号原因（duplicate loader entry id）
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -qE "^[^#]*id: *['\"]?$PLUGIN['\"]? *$" "$PATCH"; then
  warn "$(m dup_insert_1 "$PLUGIN")"
  warn "$(m dup_insert_2)"
fi

# ---- 5. 自测 + 收尾 --------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  say "$(m step5_dry)"
elif [ "$TEST" = "1" ] && command -v node >/dev/null 2>&1 && [ -d "$TARGET/test" ]; then
  say "$(m step5_test)"
  if run bash -c "cd '$TARGET' && node --test test/*.test.mjs" >/dev/null 2>&1; then
    say "$(m test_ok)"
  else
    warn "$(m test_failed "$TARGET")"
  fi
else
  say "$(m step5_skip)"
fi

say "$(m install_done)"
if [ "$LANG_ACTIVE" = "zh" ]; then
  cat <<EOF

  插件已就位:
    源码   $DEST
    安装   $TARGET
    清单   $PROFILE_DIR/package.json （已备份为 package.json.$PLUGIN.bak-$STAMP）

  还需重启 DSH 才会装载（profile 的 bundle 列表只在启动时组装）:
EOF
else
  cat <<EOF

  plugin is in place:
    sources  $DEST
    install  $TARGET
    manifest $PROFILE_DIR/package.json  (backed up as package.json.$PLUGIN.bak-$STAMP)

  DSH only picks it up after a restart (dsh.profile.bundles is assembled at boot):
EOF
fi
if [ "$RESTART" = "1" ]; then
  if [ -x "$HOME/bin/restart-dsh-web.sh" ]; then
    say "$(m restart_script)"
    run "$HOME/bin/restart-dsh-web.sh" || warn "$(m restart_script_fail)"
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files dsh-web.service >/dev/null 2>&1; then
    say "$(m restart_systemd)"
    run systemctl --user restart dsh-web.service || warn "$(m restart_systemd_fail)"
  else
    warn "$(m no_restart)"
    exit 3
  fi
  sleep 3
  say "$(m verify_cmd "$PORT")"
  run curl -s --max-time 5 "http://127.0.0.1:$PORT/api/dsh-session-pin/pins" || warn "$(m verify_fail)"
  echo
else
  if [ "$LANG_ACTIVE" = "zh" ]; then
    cat <<EOF
    · 本机有安全重启脚本时:  ~/bin/restart-dsh-web.sh
    · systemd 托管时:         systemctl --user restart dsh-web.service
    · 前台调试时:             Ctrl-C 后重新 dsh --profile $PROFILE --port $PORT

  验收（重启后）:
    curl -s http://127.0.0.1:$PORT/api/dsh-session-pin/pins      # 期望 {"version":1,"pins":{}}
  用法:
    浏览器刷新页面 → 鼠标悬停任意会话行 → 点右侧 ★ 置顶；置顶行出现 ★ 徽标并升到分组最前。
    设置 → Pinned Sessions 可批量取消。

EOF
  else
    cat <<EOF
    · with a safe restart script:  ~/bin/restart-dsh-web.sh
    · under systemd:               systemctl --user restart dsh-web.service
    · foreground debugging:        Ctrl-C, then dsh --profile $PROFILE --port $PORT

  Verify after the restart:
    curl -s http://127.0.0.1:$PORT/api/dsh-session-pin/pins      # expect {"version":1,"pins":{}}
  Usage:
    Refresh the page → hover any session row → click the ★ to pin. A pinned row shows a ★
    badge and moves to the front of its group. Settings → Pinned Sessions unpins in bulk.

EOF
  fi
fi
