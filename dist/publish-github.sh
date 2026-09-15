#!/usr/bin/env bash
# 把本仓库发布到公网 GitHub：建仓（或复用）→ 推送 main + tags → 打印安装命令。
#
# token 来源（按顺序取第一个可用的）：
#   1) 环境变量 GITHUB_TOKEN
#   2) 文件 $1，或 $GITHUB_TOKEN_FILE，或 ~/.config/dsh-publish/github-token
# 需要的权限：classic PAT 勾 repo（或 fine-grained：Administration=write + Contents=write）。
#
# 两种模式：
#   A) PAT 模式（默认）：脚本用 token 建仓 + 推送
#      mkdir -p ~/.config/dsh-publish && install -m 600 /dev/null ~/.config/dsh-publish/github-token
#      read -rs T && printf '%s' "$T" > ~/.config/dsh-publish/github-token   # 粘贴 PAT，不回显
#      bash dist/publish-github.sh
#   B) SSH 公钥模式（不交出任何密钥）：你在 GitHub 网页建好空仓库 + 把本机公钥加进账号，
#      然后 bash dist/publish-github.sh --ssh <你的GitHub用户名>
#      （github.com 直连不通，SSH 走 443 + 代理，脚本已内置）
#
# 注意：本机 github.com 直连不通，git 必须走代理；脚本会自动给这个远端配 http.https://github.com.proxy。
set -euo pipefail

MODE="pat"; SSH_LOGIN=""; FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh) MODE="ssh"; SSH_LOGIN="${2:?--ssh 后面要跟你的 GitHub 用户名}"; shift 2 ;;
    --pat) MODE="pat"; shift ;;
    --force) FORCE="--force"; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) TOKEN_FILE="$1"; shift ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 只有所在网络需要代理才能访问 github.com 时才设置（例如 GITHUB_PROXY=http://proxy:port）
PROXY="${GITHUB_PROXY:-}"
TOKEN_FILE="${1:-${GITHUB_TOKEN_FILE:-$HOME/.config/dsh-publish/github-token}}"
REMOTE="${GITHUB_REMOTE:-github}"

say() { printf '\033[1;36m[publish]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[publish] ERROR:\033[0m %s\n' "$1" >&2; exit "${2:-1}"; }

TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
fi
if [ "$MODE" = "pat" ]; then
  [ -n "$TOKEN" ] || die "没有拿到 PAT。请把它写入 $TOKEN_FILE（chmod 600）或导出 GITHUB_TOKEN；或用 --ssh <用户名> 走公钥模式。"
fi

api() { # api <method> <path> [json]
  local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS --max-time 25 -X "$m" -H "Authorization: Bearer $TOKEN" \
      -H 'accept: application/vnd.github+json' -H 'content-type: application/json' \
      -d "$body" "https://api.github.com$p"
  else
    curl -sS --max-time 25 -X "$m" -H "Authorization: Bearer $TOKEN" \
      -H 'accept: application/vnd.github+json' "https://api.github.com$p"
  fi
}

if [ "$MODE" = "ssh" ]; then
  LOGIN="$SSH_LOGIN"
  say "SSH 公钥模式。账号: $LOGIN"
  say "前置条件（在你自己浏览器里做，各一次）："
  say "  1) 已建好空仓库 https://github.com/$LOGIN/<repo>  （不要勾 README）"
  say "  2) 已把本机公钥加进 https://github.com/settings/keys"
  say "     本机公钥（这不是秘密，可直接公开）："
  sed 's/^/       /' "$HOME/.ssh/id_ed25519.pub" 2>/dev/null || say "      (读不到 ~/.ssh/id_ed25519.pub)"
else
  say "校验 token 并取得账号"
  ME="$(api GET /user)"
  LOGIN="$(printf '%s' "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("login",""))' 2>/dev/null || true)"
  [ -n "$LOGIN" ] || die "token 无效或没有 user 读取权限：$(printf '%s' "$ME" | head -c 200)"
  say "账号: $LOGIN"
fi

REPO_NAME="$(python3 -c "import json;print(json.load(open('$REPO_DIR/package.json'))['name'])")"
VERSION="$(python3 -c "import json;print(json.load(open('$REPO_DIR/package.json'))['version'])")"
DESC="$(python3 -c "import json;print(json.load(open('$REPO_DIR/package.json')).get('description',''))")"
say "仓库: $LOGIN/$REPO_NAME   版本: $VERSION"

if [ "$MODE" = "ssh" ]; then
  say "SSH 模式不调 API；若你还没建仓库，请先在 https://github.com/new 建 $REPO_NAME（不要勾 README）"
elif api GET "/repos/$LOGIN/$REPO_NAME" 2>/dev/null | grep -q '"full_name"'; then
  say "远端仓库已存在，跳过建仓"
else
  say "建仓（public）"
  OUT="$(api POST /user/repos "$(python3 -c "
import json
print(json.dumps({'name': '$REPO_NAME', 'description': '''$DESC''', 'private': False, 'has_issues': True, 'has_wiki': False, 'auto_init': False}))")")"
  if printf '%s' "$OUT" | grep -q '"full_name"'; then
    say "建仓完成"
  elif printf '%s' "$OUT" | grep -q 'already exists'; then
    say "仓库已存在（API 瞬时未列出，按已存在处理）"
  else
    die "建仓失败：$(printf '%s' "$OUT" | head -c 300)"
  fi
fi

cd "$REPO_DIR"
if [ "$MODE" = "ssh" ]; then
  # github.com 直连不通：SSH 走 ssh.github.com:443 → 代理
  URL="ssh://git@ssh.github.com:443/$LOGIN/$REPO_NAME.git"
  if [ -n "$PROXY" ]; then
    GIT_SSH_COMMAND="ssh -o ProxyCommand='nc -Xconnect -x ${PROXY#http://} %h %p' -o StrictHostKeyChecking=accept-new"
  else
    GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"
  fi
  export GIT_SSH_COMMAND
  PUSH_URL="$URL"
  [ -n "$PROXY" ] && say "推送 main + tags（SSH over 443，经代理 ${PROXY}）" || say "推送 main + tags（SSH）"
else
  [ -n "$PROXY" ] && git config --local "http.https://github.com.proxy" "$PROXY"
  URL="https://github.com/$LOGIN/$REPO_NAME.git"
  # 凭证只用在这一次 push 的 URL 上：不写进 .git/config、不写进 ~/.git-credentials
  PUSH_URL="https://$LOGIN:$TOKEN@github.com/$LOGIN/$REPO_NAME.git"
  [ -n "$PROXY" ] && say "推送 main + tags（HTTPS，经代理 $PROXY）" || say "推送 main + tags（HTTPS）"
fi
git remote remove "$REMOTE" 2>/dev/null || true
git remote add "$REMOTE" "$URL"

[ -n "$FORCE" ] && say "⚠️ --force：远端已有的提交（如建仓时自动生成的 LICENSE）会被覆盖"
GIT_TERMINAL_PROMPT=0 git push $FORCE "${PUSH_URL:-$URL}" main || {
  [ "$MODE" = "ssh" ] && die "推送失败。SSH 模式下最常见原因：仓库还没在网页建好，或公钥还没加进 GitHub（先在浏览器试 ssh -T git@github.com 应显示 successfully authenticated）。"
  die "推送失败。请确认 PAT 有 Contents: write 权限。"
}
GIT_TERMINAL_PROMPT=0 git push $FORCE "${PUSH_URL:-$URL}" --tags

say "完成 ✓  https://github.com/$LOGIN/$REPO_NAME"
cat <<EOF

别人安装（公网机，等 Release 附件由 CI 生成后）：
  curl -fsSL https://github.com/$LOGIN/$REPO_NAME/releases/latest/download/install-dsh-session-pin.sh | bash -s -- --profile web

发版（触发 CI 打包并挂到 Release 上）：
  git tag v$VERSION && git push "$REMOTE" v$VERSION

收尾提醒：
  - package.json 的 repository/homepage/bugs 已指向 GitHub；内网 Gogs 仍作为第二个远端（origin）保留。
  - 改完任何随包分发的文件后，记得 bash dist/build-release.sh 并重传交换站，保持"本地 tar ↔ 站上侧车 ↔ 分发页内嵌"一致。
  - PAT 用完就删/吊销：rm -f $TOKEN_FILE，并在 https://github.com/settings/tokens 上 Revoke。
EOF
