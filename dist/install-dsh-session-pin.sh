#!/usr/bin/env bash
# ============================================================================
# dsh-session-pin 自举安装脚本 —— 供任意 DSH 一条命令安装
# ----------------------------------------------------------------------------
# 分发地址: https://github.com/caihexin/dsh-session-pin/releases/latest/download
#           （气隙/内网环境用 --base-url 指向本地镜像，见用法②）
# 插件说明: 给 DSH Web 侧栏会话列表加「置顶/收藏」；置顶会话固定排在各分组最前，
#           状态存主机端（JSON），跨标签页/跨浏览器/重启都保留。
#
# 用法（新机器上执行）:
#   curl -fsSLO https://github.com/caihexin/dsh-session-pin/releases/latest/download/install-dsh-session-pin.sh
#   bash install-dsh-session-pin.sh --help
#
#   ① 在线安装（默认, 自动下载 + 校验 sha256 + 装进 profile）:
#      bash install-dsh-session-pin.sh --profile web
#   ② 内网镜像 / 气隙环境:
#      bash install-dsh-session-pin.sh --base-url http://<镜像>/exchange/dsh --profile web
#      或解包发布包后就地安装（完全不联网）: bash install.sh --profile web
#   ③ 只看看会做什么:
#      bash install-dsh-session-pin.sh --dry-run
#
# 其它开关: --from <dir>（用本地已解包目录, 不下载）
#           --dest <dir>（源码目录, 默认 ~/dsh-session-pin）
#           --dsh-home <dir>（默认 $DSH_HOME 或 ~/.dsh）
#           --base-url <url>（默认见下）  --no-verify（跳过 sha256, 不建议）
#           --no-test（跳过装后自测）    --keep-work（保留临时目录）
#           --restart（装完调用重启脚本）  --port <n>（验收用的端口, 默认 3080）
# 环境变量: BASE_URL / DSH_HOME / PROFILE
# 退出码: 0 成功 | 1 用法或环境错误 | 2 下载或校验失败 | 3 安装已完成但需人工重启
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

usage() { sed -n '2,26p' "$0"; }
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
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（--help 看用法）" ;;
  esac
done

[ -n "$PROFILE" ] || die "--profile 不能为空"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 脚本位于解包后的发布包内 → 自动按离线安装处理
if [ -z "$FROM" ] && [ -f "$SELF_DIR/package.json" ] && grep -q "\"name\": *\"$PLUGIN\"" "$SELF_DIR/package.json" 2>/dev/null; then
  FROM="$SELF_DIR"
  say "检测到脚本就在发布包内, 走离线安装: $FROM"
fi

command -v python3 >/dev/null 2>&1 || die "缺少 python3（用于安全改写 profile 的 package.json）"
command -v tar >/dev/null 2>&1 || die "缺少 tar"

say "目标: profile=$PROFILE  dsh_home=$DSH_HOME  源码目录=$DEST"
[ -d "$PROFILE_DIR" ] || die "profile 目录不存在: $PROFILE_DIR
  先让该 DSH 用这个 profile 起一次（例如 dsh --profile $PROFILE --port $PORT --no-open），
  或改用 --dsh-home 指向真正的 DSH 主目录。"
[ -f "$PROFILE_DIR/package.json" ] || die "profile 缺少 package.json: $PROFILE_DIR"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/${PLUGIN}-install.XXXXXX")"
cleanup() { [ "$KEEP" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT

# ---- 1. 取包（在线: 下载 + 校验；离线: 用 --from 目录） --------------------
if [ -n "$FROM" ]; then
  [ -f "$FROM/package.json" ] || die "--from 目录里没有 package.json: $FROM"
  SRC="$FROM"
  say "步骤1/5 使用本地发布包: $SRC"
else
  command -v curl >/dev/null 2>&1 || die "缺少 curl（离线安装请用 --from <已解包目录>）"
  say "步骤1/5 下载 $TARBALL （$BASE_URL）"
  run curl -fsSL -o "$WORK/$TARBALL" "$BASE_URL/$TARBALL" || die "下载失败: $BASE_URL/$TARBALL" 2
  if [ "$VERIFY" = "1" ]; then
    if run curl -fsSL -o "$WORK/$TARBALL.sha256" "$BASE_URL/$TARBALL.sha256"; then
      run bash -c "cd '$WORK' && sha256sum -c '$TARBALL.sha256'" || die "sha256 校验失败（包可能损坏或被篡改）" 2
    else
      warn "交换站上没有 .sha256 校验文件, 跳过校验"
    fi
  else
    warn "--no-verify: 已跳过 sha256 校验"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    SRC="$WORK/${PLUGIN}-${VERSION}"
    say "      [dry-run] 跳过下载与解包（按 $SRC 演示后续步骤）"
  else
    run tar -xzf "$WORK/$TARBALL" -C "$WORK" || die "解包失败" 2
    SRC="$WORK/${PLUGIN}-${VERSION}"
    [ -d "$SRC" ] || SRC="$(find "$WORK" -maxdepth 2 -name package.json -path "*${PLUGIN}*" -printf '%h\n' | head -1)"
    [ -n "$SRC" ] && [ -d "$SRC" ] || die "解包后找不到发布包目录" 2
    say "      解包完成: $SRC"
  fi
fi

if [ "$DRY_RUN" != "1" ]; then
  for f in package.json cordis.patch.yml lib/index.js lib/client.js; do
    [ -f "$SRC/$f" ] || die "发布包不完整, 缺少 $f（$SRC）"
  done
fi

# ---- 2. 落到稳定源码目录 ---------------------------------------------------
say "步骤2/5 释放源码到 $DEST"
run mkdir -p "$DEST"
for item in package.json cordis.patch.yml lib test README.md docs; do
  [ -e "$SRC/$item" ] || continue
  run rm -rf "$DEST/$item"
  run cp -a "$SRC/$item" "$DEST/"
done
[ -f "$DEST/lib/index.js" ] && [ -f "$DEST/lib/client.js" ] || [ "$DRY_RUN" = "1" ] || die "源码释放后缺少 lib/*.js"

# ---- 3. 装进 profile 的 node_modules --------------------------------------
TARGET="$PROFILE_DIR/node_modules/$PLUGIN"
say "步骤3/5 安装插件到 $TARGET"
run mkdir -p "$TARGET"
for item in package.json cordis.patch.yml lib test README.md docs; do
  [ -e "$DEST/$item" ] || continue
  run rm -rf "$TARGET/$item"
  run cp -a "$DEST/$item" "$TARGET/"
done

# ---- 4. 登记到 profile 清单（幂等, 先备份） --------------------------------
say "步骤4/5 登记 bundle: dependencies + dsh.profile.bundles"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ "$DRY_RUN" != "1" ]; then cp -a "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.$PLUGIN.bak-$STAMP"; fi
if [ "$DRY_RUN" = "1" ]; then
  say "  [dry-run] 将登记 dependencies.$PLUGIN=file:$DEST 与 dsh.profile.bundles += $PLUGIN"
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
  warn "profile 的 cordis.patch.yml 里还有 id: $PLUGIN 的手动 insert —— 与 bundle 自带的插入重复,"
  warn "DSH 会以 \"duplicate loader entry id\" 启动失败。请删掉那段 insert 后重启。"
fi

# ---- 5. 自测 + 收尾 --------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  say "步骤5/5 [dry-run] 跳过装后自测与重启"
elif [ "$TEST" = "1" ] && command -v node >/dev/null 2>&1 && [ -d "$TARGET/test" ]; then
  say "步骤5/5 装后自测（node --test）"
  if run bash -c "cd '$TARGET' && node --test test/*.test.mjs" >/dev/null 2>&1; then
    say "      自测通过 ✓"
  else
    warn "自测未通过（插件可能仍可用, 但请把输出发回来: cd $TARGET && node --test test/*.test.mjs）"
  fi
else
  say "步骤5/5 跳过自测（--no-test 或本机没有 node / 包里没有 test/）"
fi

say "安装完成 ✓"
cat <<EOF

  插件已就位:
    源码   $DEST
    安装   $TARGET
    清单   $PROFILE_DIR/package.json （已备份为 package.json.$PLUGIN.bak-$STAMP）

  还需重启 DSH 才会装载（profile 的 bundle 列表只在启动时组装）:
EOF
if [ "$RESTART" = "1" ]; then
  if [ -x "$HOME/bin/restart-dsh-web.sh" ]; then
    say "--restart: 调用 ~/bin/restart-dsh-web.sh"
    run "$HOME/bin/restart-dsh-web.sh" || warn "重启脚本返回非 0, 请人工确认"
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files dsh-web.service >/dev/null 2>&1; then
    say "--restart: systemctl --user restart dsh-web.service"
    run systemctl --user restart dsh-web.service || warn "systemctl 返回非 0, 请人工确认"
  else
    warn "没找到重启脚本或 systemd 单元, 请手动重启 DSH"
    exit 3
  fi
  sleep 3
  say "验收: curl -s http://127.0.0.1:$PORT/api/dsh-session-pin/pins"
  run curl -s --max-time 5 "http://127.0.0.1:$PORT/api/dsh-session-pin/pins" || warn "验收请求失败, 请确认端口与进程"
  echo
else
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
fi
