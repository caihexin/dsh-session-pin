[English](README.md) | **简体中文**

# dsh-session-pin

给 **DeepSeek Harness Web** 侧栏会话列表加「置顶 / 收藏」。
置顶的会话固定在所在列表最前，状态存在主机端，刷新页面、换浏览器、重启 DSH 都不会丢。

```
┌ my-workspace ─────────────────────────┐
│ ★ 示例：会话缓存重构          5min    │  ← 置顶：★ 徽标 + 排在组内最前
│   New Session                         │
│   示例：部署抖动排查          15h     │  ← 悬停此行 → 右侧出现 ★ 可点
│   示例：检索参数调优          21h     │
└───────────────────────────────────────┘
```

## 功能一览

| 位置 | 行为 |
| --- | --- |
| 会话行（悬停） | 行右侧动作区出现 ★ 按钮，点一下置顶 / 取消 |
| 已置顶的行 | 标题前出现常驻 ★ 徽标 |
| 列表顺序 | 置顶行升到**自己所在账户桶**最前（分组视图 = workspace 组内；未分组 = 未分组桶；扁平列表 = 整个列表） |
| 设置 → *Pinned Sessions* | 列出所有置顶，支持逐条取消与 *Unpin all*（全部取消） |
| 主机端 | `~/.dsh/plugin-data/dsh-session-pin/pins.json`，每小时清理会话已删除的置顶 |

排序通过 DSH **自带的** workspace store action（`setSessionOrder`）写入——不替换任何组件；
浏览器另存一份 `localStorage` 镜像，多标签页用 `storage` 事件实时同步。

## HTTP 接口

| 路由 | 含义 |
| --- | --- |
| `GET  /api/dsh-session-pin/pins` | 完整状态 `{version, pins:{id:{pinned,pinnedAt}}}` |
| `POST /api/dsh-session-pin/set` | `{sessionId, pinned, pinnedAt?}` → 返回刷新后的状态 |
| `POST /api/dsh-session-pin/prune` | `{ids:[…]}` → `{pins:{id:{exists}}}` 存在性探测 |

## 安装

### 从 GitHub 安装（推荐）

```bash
mkdir -p ~/dsh-pin && cd ~/dsh-pin
curl -fsSLO https://github.com/caihexin/dsh-session-pin/releases/latest/download/install-dsh-session-pin.sh
bash install-dsh-session-pin.sh --dry-run          # 先看看它要做什么
bash install-dsh-session-pin.sh --profile web      # 下载 + 校验 sha256 + 安装
# 重启 DSH Web 之后验收：
curl -s http://127.0.0.1:3080/api/dsh-session-pin/pins     # {"version":1,"pins":{}}
```

一行装：

```bash
curl -fsSL https://github.com/caihexin/dsh-session-pin/releases/latest/download/install-dsh-session-pin.sh | bash -s -- --profile web
```

### 从源码安装

```bash
git clone https://github.com/caihexin/dsh-session-pin.git
cd dsh-session-pin
npm test                                                      # 13 项自测
bash dist/install-dsh-session-pin.sh --from . --profile web    # 用本地源码装
```

### 气隙 / 内网镜像

机器访问不到 github.com 时，把同一个安装脚本指向任意能提供那四个文件的 HTTP 镜像
（`install-*.sh`、`*.tar.gz`、`*.tar.gz.sha256`、`INSTALL-README-*.md`）：

```bash
bash install-dsh-session-pin.sh --base-url http://<镜像>/exchange/dsh --profile web
```

或者把发布包带过去解包安装（完全不联网）：

```bash
tar -xzf dsh-session-pin-0.1.0.tar.gz && cd dsh-session-pin-0.1.0
bash install.sh --profile web
```

完整的手动安装、卸载与排障见 [`docs/install-and-deploy.zh-CN.md`](docs/install-and-deploy.zh-CN.md)；
发版与维护见 [`docs/publishing-guide.zh-CN.md`](docs/publishing-guide.zh-CN.md)。
（英文版：`docs/install-and-deploy.en.md`、`docs/publishing-guide.en.md`）

### 手动安装

本包是一个 DSH **bundle**：包含 host 半（`lib/index.js`）、通过 `exports["./client"]` 暴露的浏览器半
（`lib/client.js`），以及挂载 host 入口的 loader patch（`cordis.patch.yml`）。

```bash
# 1. 让 profile 能解析到它，并把它登记为一个 bundle 层
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

# 2. 重启 web 表面（先冒烟再切换，切勿"先杀后启"）
~/bin/restart-dsh-web.sh          # 该环境存在此脚本时
```

**不要**再往 profile 自己的 `cordis.patch.yml` 里手写 `dsh-session-pin` 的 `insert`：
bundle 自带的 patch 已经插入，重复会导致启动失败并报 `duplicate loader entry id`。

改 `lib/client.js` 后**不需要重启**——bundle 以 `cache-control: no-cache` 从磁盘实时读取
（`/plugins/dsh-session-pin/client.js`），刷新页面即可生效。改 `package.json`（如 `immediately`）
则需要重启，因为 boot manifest 在启动时组装。

### 打发布包

```bash
bash dist/build-release.sh    # → dist/*.tar.gz + .sha256 + 分发页 INSTALL-README
```

## 测试

```bash
npm test        # node --test test/*.test.mjs（Node 22 不接受裸目录参数）
```

`test/smoke.test.mjs` 覆盖共享排序纯函数、host 的 HTTP 处理与状态文件生命周期，并用假 DOM
把浏览器 bundle 跑起来——假 DOM 复刻了 shipped React 组件的 fiber props（行 fiber 上的 `node`、
祖先上的排序 action 与 `workspaces`）以及**与浏览器一致的 `innerHTML` 序列化行为**。

## 本包已经踩过的两个坑

1. **永远不要靠重写外部节点来"刷新"它。** `btn.innerHTML !== 模板` **恒为真**——浏览器把
   `<path/>` 序列化成 `<path></path>`。旧实现每轮扫描都重建按钮子树，而某次重建落在
   `mousedown` 与 `mouseup` 之间时，浏览器会**完全丢弃 click**：图标在，点了没反应。
   要记录"已渲染状态"（dataset 标记），而不是比较标记文本。
2. **排序桶不是行自身 prop 上的字段。** 分组树里，行 fiber 只带会话 `node`；拥有
   `setSessionOrder` 的组件在**祖先**上，并且带 `workspaces`——其 `workspaceId` 才是桶键
   （未分组为 `""`）。无层级的扁平列表不传 `workspaces`，全部归到 shipped 键
   `"__flat_session_order__"`。写到错的键上会"看起来成功"但顺序纹丝不动。

---

许可：MIT（见 [`LICENSE`](LICENSE)）。变更记录：[`CHANGELOG.md`](CHANGELOG.md)。
参与贡献：[`CONTRIBUTING.md`](CONTRIBUTING.md)。
