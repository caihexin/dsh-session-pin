#!/usr/bin/env bash
# 打 dsh-session-pin 发布包 + sha256 侧车 + 交换站分发页（INSTALL-README）。
# 用法: bash build-release.sh            # 产物落在 ./dist/
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$PKG_DIR/dist"
NAME="dsh-session-pin"
VERSION="$(python3 -c "import json;print(json.load(open('$PKG_DIR/package.json'))['version'])")"
STAGE_NAME="$NAME-$VERSION"
STAGE="$DIST/$STAGE_NAME"
# 分发地址可用环境变量覆盖（默认 GitHub Release；内网镜像传 BASE_URL=http://<镜像>/exchange/dsh）
BASE_URL="${BASE_URL:-https://github.com/caihexin/dsh-session-pin/releases/latest/download}"

say() { printf '\033[1;36m[build]\033[0m %s\n' "$*"; }

say "版本 $VERSION → $DIST"
rm -rf "$STAGE" "$DIST/$STAGE_NAME.tar.gz" "$DIST/$STAGE_NAME.tar.gz.sha256"
mkdir -p "$STAGE"

# 发布内容（不含 dist/ 自身、不含 .git）
for item in package.json cordis.patch.yml lib test docs README.md LICENSE CHANGELOG.md; do
  [ -e "$PKG_DIR/$item" ] || { echo "缺少 $item" >&2; exit 1; }
  cp -a "$PKG_DIR/$item" "$STAGE/"
done
cp -a "$DIST/install-dsh-session-pin.sh" "$STAGE/install.sh"
cp -a "$DIST/build-release.sh" "$DIST/publish-github.sh" "$STAGE/"
chmod +x "$STAGE/install.sh"

say "自测（发布前必须全绿）"
( cd "$STAGE" && npm test >/dev/null 2>&1 || node --test test/*.test.mjs >/dev/null ) \
  || { echo "发布包内测试未通过，已中止" >&2; exit 1; }
say "自测通过 ✓"

say "打包 $STAGE_NAME.tar.gz"
# 可复现打包：固定排序/时间戳/属主 + gzip -n（不写文件名与时间戳）→ 同样内容必得同样字节，
# 这样任何人都能重新构建并比对 sha256。
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -cf - -C "$DIST" "$STAGE_NAME" | gzip -n -9 > "$DIST/$STAGE_NAME.tar.gz"
( cd "$DIST" && sha256sum "$STAGE_NAME.tar.gz" > "$STAGE_NAME.tar.gz.sha256" )
SHA="$(cut -d' ' -f1 < "$DIST/$STAGE_NAME.tar.gz.sha256")"
SIZE="$(stat -c%s "$DIST/$STAGE_NAME.tar.gz")"

# 交换站分发页：包内文档 + 分发头 + 内嵌校验和
say "生成交换站分发页 INSTALL-README-$NAME.md"
{
  cat <<EOF
# dsh-session-pin $VERSION · 交换站分发页

**分发地址**：<$BASE_URL/>
**内容**：\`$NAME\` $VERSION —— 给 DSH Web 侧栏会话列表加「置顶 / 收藏」（host 半 + 浏览器半 + loader patch，无 npm 依赖）
**打包日期**：$(date +%F)　|　**来源**：$(hostname) 现网插件 \`$PKG_DIR\`

## 文件清单

| 文件 | 说明 |
| --- | --- |
| \`install-dsh-session-pin.sh\` | **自举安装脚本**（下载 + sha256 校验 + 装进 profile；含 \`--dry-run\`） |
| \`$STAGE_NAME.tar.gz\` | 发布包（$((SIZE/1024)) KB）：插件源码 + 测试 + 安装脚本 + 部署说明 |
| \`$STAGE_NAME.tar.gz.sha256\` | 发布包 sha256 校验文件 |
| \`INSTALL-README-$NAME.md\` | 本文件 |

校验和（发布包）：
\`\`\`
sha256: $SHA
\`\`\`

## 安装（三步）

\`\`\`bash
# 1) 下载脚本
mkdir -p ~/dsh-pin && cd ~/dsh-pin
curl -fsSLO $BASE_URL/install-dsh-session-pin.sh

# 2) 先干跑，再正式装（自动下载发布包 + 校验 sha256 + 登记 bundle）
bash install-dsh-session-pin.sh --dry-run
bash install-dsh-session-pin.sh --profile web

# 3) 重启 DSH 后验收
curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins     # 期望 {"version":1,"pins":{}}
\`\`\`

不便分步时也可一行装：
\`\`\`bash
curl -fsSL $BASE_URL/install-dsh-session-pin.sh | bash -s -- --profile web
\`\`\`

离线安装（发布包已解包）：
\`\`\`bash
tar -xzf $STAGE_NAME.tar.gz && cd $STAGE_NAME && bash install.sh --profile web
\`\`\`

## 使用

浏览器刷新页面 → 鼠标悬停任意会话行 → 点右侧 ★ 置顶；置顶行出现 ★ 徽标并升到分组最前。
设置 → **Pinned Sessions** 可逐条取消或一键全清。状态存主机端
\`~/.dsh/plugin-data/dsh-session-pin/pins.json\`，跨标签页/浏览器/重启保留。

## 给「新 DSH」的原话指令（可直接粘贴给它的 agent）

> 请从 $BASE_URL/ 下载 \`install-dsh-session-pin.sh\`，依次执行
> \`bash install-dsh-session-pin.sh --dry-run\` 与 \`bash install-dsh-session-pin.sh --profile web\`
> （脚本会自动下载并校验发布包 sha256），随后重启 DSH Web 表面，并用
> \`curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins\` 验收（期望 \`{"version":1,"pins":{}}\`），
> 回报安装路径与插件启动日志。

## 注意事项

- **不要**再往 profile 自己的 \`cordis.patch.yml\` 手写 \`id: dsh-session-pin\` 的 \`insert\`：发布包自带
  的 patch 已插入该条目，重复会导致启动失败（\`duplicate loader entry id\`）。脚本会检测并告警。
- **装完必须重启** DSH：profile 的 \`dsh.profile.bundles\` 只在启动时组装。改 \`lib/client.js\` 则不必重启
  （bundle 以 \`cache-control: no-cache\` 实时读盘），刷新页面即可。
- 若页面里**星标在但点了没反应**，说明浏览器还在跑 0.1.0 之前的旧 bundle，请强制刷新
  （Ctrl/Cmd+Shift+R）。
- 完整说明见发布包内 \`docs/安装部署说明.md\`（含手动四步、卸载、排障表、文件路径表）。

EOF
} > "$DIST/INSTALL-README-$NAME.md"

say "产物:"
ls -l "$DIST" | sed 's/^/  /'
echo
echo "sha256: $SHA"
echo
echo "上传（示例）:"
echo "  for f in install-dsh-session-pin.sh INSTALL-README-$NAME.md $STAGE_NAME.tar.gz $STAGE_NAME.tar.gz.sha256; do"
echo "    curl -fsS -T \"$DIST/\$f\" \"$BASE_URL/\$f\"; done"
