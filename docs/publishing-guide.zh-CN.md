[English](publishing-guide.en.md) | **简体中文** | [← 返回中文 README](../README.zh-CN.md)

# 发布指南（发版、GitHub、npm、内网镜像）

本文是**通用**发布说明：任何人 fork 这个仓库后都能照做。内网专有的主机/交换站地址不在仓库里，
由使用团队内部提供（安装侧见 `docs/安装部署说明.md`）。

## 0. 分发通道

| 通道 | 别人怎么拿到 | 需要什么 |
| --- | --- | --- |
| **GitHub（源码 + Release 附件）** | `git clone` / Release 里的自举脚本一条命令装完 | 读：无；推：PAT 或 SSH 公钥 |
| **npm（可选）** | `npm i dsh-session-pin` 或 `dsh plugin add dsh-session-pin` | npmjs token |
| **内网镜像（可选）** | 团队自建的只读 HTTP 交换站，用法与 GitHub Release 完全一致 | 站点地址由团队提供 |

三条通道发的是同一个包：`dsh-session-pin-<版本>.tar.gz` + `.sha256` + `install-dsh-session-pin.sh` + 分发页。

## 1. 发版固定动作

```bash
npm test                                   # 必须全绿（node --test，13 项）
# 改 package.json 的 version，在 CHANGELOG.md 追一节
bash dist/build-release.sh                 # → dist/*.tar.gz + .sha256 + INSTALL-README-*.md
git add -A && git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "dsh-session-pin X.Y.Z"
git push && git push --tags                # 推 tag 会触发 CI 打包并挂 Release 附件
```

`build-release.sh` 做四件事：跑测试 → 打 `dsh-session-pin-<版本>.tar.gz`（含 `install.sh`、`docs/`、`test/`）
→ 生成 `.sha256` 侧车 → 用包内文档生成分发页 `INSTALL-README-*.md`（内嵌 sha256）。

分发地址默认指向本仓库的 Release，可用环境变量覆盖（例如指向团队内网镜像）：

```bash
BASE_URL=http://<你的镜像>/exchange/dsh bash dist/build-release.sh
```

> ⚠️ 发布物改了（哪怕只改一行 README）就要**重新构建并整链重传**，
> 否则站点上的侧车哈希与实际包不符，安装脚本会拒绝安装。

### 打包是可复现的

`build-release.sh` 用 `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - … | gzip -n -9`，
固定了排序、时间戳与属主，并让 gzip 不写文件名/时间戳。因此在**同一台机器上，相同内容的两次构建
得到完全相同的字节与 sha256**，第三方可以自行重建比对。

一个真实存在的限制：**不同 gzip 实现/版本产出的压缩流可能不同**（实测本机 gzip 1.12 与
GitHub Actions runner 上的 gzip 对同样内容给出不同字节）。所以跨机器核对"内容是否一致"时，
请比对**解包后的内容**（`tar -xzf` 后 `diff -r`），或只核对"各通道侧车 ↔ 该通道的包"是否匹配——
`tar -czf` 连同一台机器的两次构建都不可复现（gzip 会把当前时间写进头部）。

## 2. 发到 GitHub

准备一次性身份（二选一）：

**A. PAT（Personal Access Token）** —— GitHub 已不允许用登录密码推代码，命令行只能用 PAT 或 SSH 公钥。
在 <https://github.com/settings/tokens> → **Generate new token**：

- **Tokens (classic)**：勾 `repo` 即可；有效期按需（建议短）。
- **Fine-grained tokens**：Repository access 选目标仓库；权限 `Administration: write`（建仓）+ `Contents: write`（推送）。

把 token 交给本机（不要写进 shell 历史或聊天记录）：

```bash
mkdir -p ~/.config/dsh-publish && install -m 600 /dev/null ~/.config/dsh-publish/github-token
read -rs T && printf '%s' "$T" > ~/.config/dsh-publish/github-token && unset T
```

**B. SSH 公钥（不交出任何密钥）** —— 在 <https://github.com/settings/keys> 里加上运行发布那台机器的
`~/.ssh/id_ed25519.pub`，然后：

```bash
bash dist/publish-github.sh --ssh <你的GitHub用户名>
```

> 若所在网络访问 `github.com` 需要代理，先导出 `GITHUB_PROXY=http://<proxy>:<port>`；
> 脚本只在本次 push 的 URL 上携带凭证，不写进 `.git/config`，也不写进 `~/.git-credentials`。

脚本动作：校验身份 → 建仓（已存在则复用）→ 配好远端 → 推 `main` 与全部 tag。（远端已有自动生成的
初始提交时用 `--force` 覆盖。）

## 3. 发到 npm（可选）

DSH 的插件加载器从 profile 的 `node_modules` 解析 bundle，所以发上 npm 后可以用官方命令装：

```bash
read -rs NPM_TOKEN
echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > ~/.npmrc.publish
npm publish --userconfig ~/.npmrc.publish --registry https://registry.npmjs.org/
```

对方安装：

```bash
dsh plugin --profile web add dsh-session-pin
# 再把 dsh-session-pin 追加进 profile 的 dsh.profile.bundles，重启 DSH
```

> 若本机 `~/.npmrc` 的 registry 指向镜像源，发布时务必显式加 `--registry https://registry.npmjs.org/`。

## 4. 内网 / 离线镜像

镜像站只要做到"能 `GET` 到那四个文件"即可，安装方式与 GitHub Release 完全一致：

```bash
bash dist/install-dsh-session-pin.sh --base-url http://<镜像>/exchange/dsh --profile web
```

上传（以 `curl -T` 为例）：

```bash
BASE=http://<镜像>/exchange/dsh
for f in install-dsh-session-pin.sh INSTALL-README-dsh-session-pin.md \
         dsh-session-pin-0.1.0.tar.gz dsh-session-pin-0.1.0.tar.gz.sha256; do
  curl -fsS -T "dist/$f" "$BASE/$f"
done
# 回读校验：站上侧车必须与站上的包一致
curl -fsSL "$BASE/dsh-session-pin-0.1.0.tar.gz.sha256" -o /tmp/s
curl -fsSL -o /tmp/dsh-session-pin-0.1.0.tar.gz "$BASE/dsh-session-pin-0.1.0.tar.gz"
(cd /tmp && sha256sum -c s)
```

气隙环境（连镜像也不通）直接带发布包过去：

```bash
tar -xzf dsh-session-pin-0.1.0.tar.gz && cd dsh-session-pin-0.1.0
bash install.sh --profile web
```

## 5. 版本与兼容

- DSH 是 pre-1.0。浏览器半依赖 shipped 组件 props（`node` / `workspaces[].workspaceId` / `orderKey`），
  升级 DSH 后请在新版本上复跑一次安装脚本自带的自测，并在 CHANGELOG 注明"已测 DSH 版本"。
- 发布包内 `test/smoke.test.mjs` 随包分发，装完的机器可直接 `npm test` 复验。
