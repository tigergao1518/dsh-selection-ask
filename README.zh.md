# dsh-selection-ask（分支版）

![banner](assets/banner.png)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-5FA04E?logo=nodedotjs)](https://nodejs.org/)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) · [分支与上游](#分支与上游) · [本分支新增能力](#本分支新增能力) · [安装](#安装) · [使用](#使用) · [开发](#开发) · [故障排除](#故障排除) · [许可](#许可)

**选中即引用，追问可选主线或侧栏——侧栏继承完整上下文，且绝不打断主线。**

---

> ### 🍴 这是一个分支（fork）
>
> 基于 **[lzbaclz/dsh-selection-ask](https://github.com/lzbaclz/dsh-selection-ask)**（MIT，作者 lzbaclz）——原本只做「选中文本引用进输入框」这一个动作。上游最后一个版本是 **v0.1.1（2026-09-17）**，此后未再更新；本分支在同一份 MIT 许可下继续开发。
>
> **本分支新增**：继承主会话上下文的侧边栏对话、只读的会话复盘，以及一批 DSH 升级后的兼容性修复。详见[本分支新增能力](#本分支新增能力)。
>
> 本分支历次修复的完整踩坑记录见 [`docs/fork-notes.zh.md`](docs/fork-notes.zh.md)。

---

## 本分支新增能力

上游 v0.1.1 把一件事做得很好：把选中的文本引用进输入框。本分支保留它，另加三项能力。

### 1. 侧边栏对话——继承上下文，但不打断主线

在主会话里选中文本，点 **「开侧栏追问」**，右侧栏会开一个新会话，**继承到目前为止的完整对话**。它有自己的 agent、自己的对话流、自己的模型路由；而主会话照常推进，侧栏里的问答也不会回流进主会话的模型上下文。

选中的引用会**预填进侧栏输入框但不发送**——什么时候发由你决定。

- **继承是真的，不是复制**：子会话用父会话的事件构造 seed 创建，因此确实带着上下文（实测：新建侧栏会话打开即有父会话完整记录，约 470 KB，而空会话约 10 KB）。
- **绝不打断**：主会话的 agent 完全不受影响，不会取消任何轮次，不会干扰正在进行的生成。
- **同一个模型**：侧栏会话沿用父会话的 provider/model 路由，回答口径与主线一致。

### 2. 会话复盘——用数据判断，而不是凭印象

会话头部多一个 **「复盘本会话」** 入口，打开一个**只读**的复盘会话。它不继承对话原文，而是从磁盘读会话日志，提炼过程数据——每轮 token 消耗、报错与重试聚集在哪几轮、上下文组成（到底是什么在占窗口）、哪些轮次跑偏——然后按优先级给出「改什么」。

它不能写文件、不能执行命令（用专用只读预设锁死工具集），所以绝不会在复盘中途「顺手」开始改你的工作区。

### 3. DSH 升级兼容性修复

本分支是被 DSH 升级后的真实故障推着走的。其中几处属于结构性修复，如果你也在维护分支，值得知道：

- **侧栏会话走 `agents.create` + 自建 seed，不用 `sessions.fork`**：`fork` 从不落盘；事后再补 persistence 会与恢复路径相撞（`already exists`）。`agents.create` 一步完成「进 store + 落盘 + 拿到写所有权」。
- **`provider`/`model` 必须放在 `agentOptions` 里面**，它们**不是**顶层字段。写在顶层不会报错，但也不生效——错误只会在你发送消息时才暴露（`agent "…" has no provider/model`）。
- **persona 模板里不能有 `{{cwd}}` / `{{model}}`**：`{{cwd}}` 根本没注册；`{{model}}` 只在会话已经有过请求头（即发过模型请求）时才有值。全新的侧栏会话两者皆空，persona 组装会在任何模型请求之前就抛错。
- **选区按会话隔离**：侧栏会话和主会话同屏时，两边都会挂一个选区按钮、监听同一个全局 `selectionchange`。现在每个实例会校验选区是否属于**自己那个会话**，于是「存入本会话」只会写进正确的输入框。

## 功能

**上游原有（行为不变）：**

- **按钮跟随选区**——按选区屏幕坐标定位（`position: fixed`），夹在视口内，选区滚出视口即隐藏。
- **只引用对话文本**——选区必须在对话记录（`[data-conversation-scroll]`）或端内文档预览内；在输入框里选中不做任何事。
- **引用感知的追加**——每行加 `> ` 前缀；草稿为空则替换，非空则作为独立段落追加。
- **走官方接口，无 hack**——通过 harness 的 `inputActions.setDraft` 写入，撤销历史与草稿持久化都照常工作。

**本分支新增：**

- **侧边栏对话**——见上。输入卡片上两个按钮：「开侧栏追问」（次级）与「存入本会话」（主按钮，Enter 的默认动作）。
- **会话复盘**——见上。
- **侧边栏起始页入口**——起始页多一个「发起旁路对话」，不选文本也能直接开一个继承上下文的旁路会话。
- **上下文组成分析**——复盘会报告到底是什么在吃上下文窗口（系统提示词、工具 schema、工具结果、注入的记忆），按占比排序，而不是只说一句「token 太多」。

## 环境要求

- DeepSeek Harness **桌面版**（本分支的侧栏与复盘路径依赖侧栏服务；单纯的选中引用在 `web` profile 下也能用）。
- DSH 包版本 **0.2.1-rc.2** 或更新（针对 2026-10-17 桌面版构建实测）。
- 安装预编译包无需额外环境；从源码构建需要 Node `^22.19.0 || >=24` 与 pnpm。

## 安装

```bash
dsh plugin --profile desktop add github:tigergao1518/dsh-selection-ask
```

然后**重启 DSH**——host 半的改动（RPC 路由与会话工厂）只在重启后生效。client 半的改动只需刷新页面。

**从本地克隆安装：**

```bash
git clone https://github.com/tigergao1518/dsh-selection-ask.git
dsh plugin --profile desktop add link:/absolute/path/to/dsh-selection-ask
```

> 编译产物 `lib/` 已提交，因此 `github:` 或 `link:` 安装拿到的就是可直接加载的产物，无需构建。

## 使用

### 引用进主线（上游原有行为）

1. 在对话记录里选中文本。
2. 点 **「询问 DeepSeek」**。
3. 引用进入输入框（`> 选中的文本`），输入框获得焦点、光标在末尾。补上你的问题再发——或者直接按 **Enter**（默认动作，等价于点「存入本会话」）。

### 在侧栏追问，不打断主线

1. 在主会话里选中文本。
2. 点 **「询问 DeepSeek」**，再点 **「开侧栏追问」**（或从侧边栏起始页的「发起旁路对话」进入）。
3. 侧栏会话打开，已继承完整上下文。引用预填进它的输入框——**不会自动发送**。检查一下、补上问题，想发再发。

主会话照常运行。你在侧栏问的任何内容都不会进入主线的模型上下文。

### 复盘会话

点会话头部的 **「复盘本会话」**。一个只读复盘会话打开，报告报错与重试、上下文膨胀、跑偏轮次、可回退点。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-selection-ask
```

## 故障排除

| 现象 | 原因与处理 |
|---|---|
| `agent "…" has no provider/model` | 侧栏会话没有模型路由。先在**主会话**发一条消息（请求头就是侧栏会话继承的来源）。本分支已经把 `agentOptions` 透传下去，报这句说明当时确实没东西可继承。 |
| `prompt variable "{{model}}" has no value` | persona 模板里还引用着 `{{model}}`，它只在会话发过模型请求后才有值。把预设 persona 的 `prefix` 改成不含变量的静态文本——本分支的 `docs/check-persona-vars.mjs` 正是用来扫这个的。 |
| 侧栏发送报 `SessionPersistenceNotFoundError` | 你用的是走 `sessions.fork` 的旧构建（它从不落盘）。换成本分支的 `agents.create` 路径。 |
| 选中引用跑进了侧栏输入框而不是主线 | 本分支已用按会话隔离的选区判定修掉。若仍出现，说明锚点没能解析出会话根，请提 issue。 |
| 选中后按钮不出现 | 选区不在对话记录内、激活后没刷新页面，或 `insert` 行缺失。 |
| 按钮出现但点了没反应 | 硬刷新（Cmd/Ctrl+Shift+R）清掉缓存的旧 bundle。 |

## 开发

```bash
git clone https://github.com/tigergao1518/dsh-selection-ask.git
cd dsh-selection-ask
pnpm install
pnpm typecheck   # host + client 两个 tsc 程序，零错误
pnpm build       # tsc(host) + tsc(client) + tsdown 打包
```

DSH 升级后值得跑一遍的兼容性检查（都在 `docs/`）：

```bash
node docs/check-compat.mjs            # 本插件用到的服务/API/插槽/主题 token 还在不在？
node docs/check-persona-vars.mjs desktop docs/session-review-preset.yml   # persona 模板里有没有解析不了的 {{...}}？
node docs/check-plugin-build.mjs      # 构建产物断言
```

### 目录

- `src/index.ts` — host 半：RPC 路由、侧栏会话工厂、复盘工厂、`read_session_log` 工具。
- `src/sideSession.ts` — 侧栏会话工厂（`agents.create` + 自建 seed）与模型路由解析。
- `src/reviewSession.ts` — 只读复盘会话的组装。
- `src/client/SelectionAskButton.tsx` — 浮动按钮：选区检测、定位、按会话隔离。
- `src/client/sideAskTab.tsx` — 侧栏 tab、起始页指南入口、对话宿主。
- `src/client/SideDraftRestore.tsx` — 把草稿预填进侧栏输入框，不发送。
- `docs/` — DSH 升级兼容性检查脚本、复盘预设，以及[本分支的修复记录](docs/fork-notes.zh.md)。

## 分支与上游

| | |
|---|---|
| 上游 | [lzbaclz/dsh-selection-ask](https://github.com/lzbaclz/dsh-selection-ask) — MIT，© lzbaclz |
| 上游最后版本 | v0.1.1（2026-09-17） |
| 本分支 | [tigergao1518/dsh-selection-ask](https://github.com/tigergao1518/dsh-selection-ask) — MIT，同一许可 |
| 关系 | 分支；上游已不再活跃更新，故本分支独立维护 |

**原有「选中引用」行为的问题**仍应去上游提 issue / PR。侧栏对话、会话复盘、DSH 兼容性修复相关的问题，请在**本仓库**提。

## 许可

[MIT](./LICENSE) — © lzbaclz（上游）及本分支贡献者。
