# dsh-selection-ask 0.6.0

给 DSH 加三个入口：

- **选中追问** —— 选中会话里的文字，在右侧栏开一个继承当前上下文的旁路会话追问，
  主会话不被打断，追问内容也不写回主线。文本**预填到输入框、不自动发送**。
- **侧栏开始页入口** —— 右侧栏开始页多了「发起旁路对话」胶囊，点一下
  就开一个空的旁路会话，不用先选中文本。
- **会话复盘** —— 读**会话日志文件**，在只读预设下新开一个复盘会话，
  分析报错、上下文膨胀、跑偏轮次与可回退点。

## 0.6.0 — 旁路会话改走 agents.create + 自建 seed

侧栏发送报错修了四轮，根因一层比一层深：

| 版本 | 报错 | 根因 |
|---|---|---|
| 0.3.0/0.3.1 | `session "…" already exists` | fork 之后又调 agents.create，prepare 撞 store |
| 0.4.x | `SessionPersistenceNotFoundError` | 改成只 fork，但 fork **不落盘** |
| 0.5.x | `already exists` | 自己补 persistence.create，resume 时 `registerCreated` 撞 writers |
| 0.5.2 | `cannot get property … without inject` | 补 inject 声明，暴露了更底层的隔离 |

最后读 app.asar 确认了三件事：

1. **`sessionPersistence` 被 isolate 隔离**。它不在 Cordis Inspect 的服务目录里
   （`sessions`/`agents` 在），而官方 ACP 与 Agent Teams 的 `TeamService` 都靠
   `static inject` 声明它才能用——说明它在官方 isolate 域内，第三方插件的
   fiber 不在同一域。
2. **`session/flush` 救不了**。持久化的 flush listener 是
   `if (writers.get(id) === undefined) return`，而 writers 只在
   `persistence.create()` 时注册。fork 出的会话没有 writer，flush 是纯空操作。
3. **`registerCreated` 是第二个 already exists 的来源**：
   `if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(...)`

### 正解

`agents.create` 的参数结构与 `sessions.create` 几乎一样（都收
`seed` / `inheritedEventCount` / `meta`），而它内部
`createStoredSession → persistence.create(header)` **一步同时完成
「进 store + 落盘 + 拿 write 所有权」**。没有 fork，就没有后面的重复
create，两个 already exists 都不存在，也不需要直接碰被 isolate 的服务。

复盘路（createFreshSession）一直是这么走的，早已验证可落盘、可发送。

seed 构造复刻官方 `buildForkSeed`：

```js
const events = parent.snapshotEvents()
const boundary = events.at(-1).seq
const seed = [
  ...events.slice(0, boundary + 1),
  { type: 'session/end-seed', seq: boundary + 1, time: events[boundary].time, data: { inherited: true } },
]
```

唯一没复刻的是 `openTurnClosers`：它只对「父会话正在跑 turn」有意义，
给未收尾的 turn 补 closer。用户是读完再选中，父会话通常空闲，此时它返回
空数组；真遇到正在跑的父会话，恢复时 DSH 会按「轮次中途崩溃」处理
（它本就有这套修复逻辑）。

### 顺带清掉的依赖

`inject` 数组撤掉了 `sessionPersistence`（不再需要直接访问它），
`persistForkedChild` 整个函数删除。

## 0.5.2 — sessionPersistence 取不到报错

### 1. 侧栏发送报 `SessionPersistenceNotFoundError`（最严重）

报错原文：

```
resume failed for session "session-side-…": SessionPersistenceNotFoundError:
session "session-side-…" not found (gateway/internal)
```

根因：**`sessions.fork()` 不落盘**。它内部只走
`prepare → enter → announce`，子会话仅存在于**内存 store**；
而侧栏一发送消息就会走
`coldResume → persistence.open(id, "write")`，磁盘上没记录就抛 not found。

复盘路走 `agents.create`（内部有 `createStoredSession`）所以从没暴露这个问题；
选中追问是 fork 路，一发送就炸。**换句话说：选中追问的「发送」从来没能用过。**

修法：fork 之后补一步落盘——`persistence.create(header)` 建记录 →
`append(seed)` 把父会话前缀写进去 → `flush` 保证物理文件出现 →
`close` 释放句柄。三步缺一不可：
- 不 create：coldResume 找不到会话
- 不 append：恢复出来是空会话，没有继承的上下文
- 不 flush：空会话在重启前不会生成物理文件

> 注意：host 半的改动**必须重启 DSH 桌面版**才生效（client 半刷新页面即可）。

### 2. 「开侧栏追问」改为预填不发送

原来的行为是把「引用 + 问题」通过 `subagents.queuePrompt` **直接发出去**。
用户要的是「带进输入框、由我自己决定何时发」。

改成：点击时文本暂存在 `pendingDrafts`（按子会话 id 索引），
由注册在 `conversation.input.left` 的回填条目在子会话 composer 挂载时
`setDraft` 写入。机制与 dsh-turn-actions 的回填器相同（那条路已实测可用）。

`queuePrompt` 那条路保留：调用方显式传 `firstMessage` 时才走
（比如将来要做「一键发起并自动跑」）。

### 3. 侧栏开始页新增「发起旁路对话」

`sidebarRightTabs.register({ ..., guide: [...] })` 支持贡献开始页入口。
但官方默认点击行为只 `openTab(kind)` 开一个**空 tab**——没有 address，
SideAskTab 会一直停在「正在载入会话」。

所以分两半做：
1. tab 注册加 `guide` 字段，让胶囊出现在开始页；
2. 注册 `sidebar.right.tab.guide.entry`（key = 本插件的 tab 类型 id）
   接管点击：先 fork 旁路会话，再用它的 address 打开。

胶囊在「没打开任何会话」时禁用（没有可继承的父会话）。

## 0.4.2 — 复盘新增「上下文组成」

0.4.0/0.4.1 的复盘只能说出「第 3 轮 19.9k tok」，**说不出这 19.9k 是什么构成的**。
所以「上下文膨胀」这一类永远停留在"token 多"，给不出可执行结论。

0.4.2 补上组成分析。数据全部来自日志（无需第三方插件）：

```
上下文组成（合计 2671.1k 字符，窗口 1024.0k tok）：
  工具结果：2356.6k 字符，占 88.2%
  工具 schema（113 个工具）：157.3k 字符，占 5.9%
  用户消息：73.6k 字符，占 2.8%
  助手回复：68.9k 字符，占 2.6%
  系统提示：9.4k 字符，占 0.4%
  注入内容：5.3k 字符，占 0.2%
  → 最大头是「工具结果」，要控制上下文先看它。
```

这个结论直接改变建议方向：**该做的不是「省 token」，而是「少用会吐大段输出的工具」**。

采集口径（都有讲究）：

| 项 | 取法 | 为什么 |
|---|---|---|
| 系统提示 | **最后一条** | 它会被替换，只有最后一条是当前生效的 |
| 工具 schema | **最后一次 `request/header`** | 反映当前工具集，中间态无意义 |
| 工具结果 | 累计 | 长会话里通常是最大头 |
| 用户/助手消息 | 累计 | — |
| 注入内容 | 累计 | 插件与系统注入也要占窗口 |

**为什么不用 dsh-context**：那个插件（bowenliang123）做的是「给人看的上下文仪表盘」，
读运行时投影；复盘是模型自动分析、读日志文件。而且它的核心数据（系统提示全文、
工具 schema、各类消息字符量）**日志里全有**，自己算更直接，不必引第三方依赖。

## 0.4.1 — 修侧边栏 tab 不渲染、按钮顺序与深色主按钮配色

0.3.x 的复盘是「fork 主会话，靠提示词让它别乱改」。那条路有个硬伤：
fork 出的会话已经「开始过」，官方 `agent-preset/locked` 拒绝再切预设，
**只读约束落不了地**，只能靠提示词劝。

0.4.0 换了架构：

| | 选中追问 | 会话复盘 |
|---|---|---|
| 会话 | fork 父会话 | **新开会话** |
| 上下文 | 完整继承对话 | 不继承；读**日志文件**提炼过程数据 |
| 预设 | 继承父会话 | **指定只读预设，真正生效** |

新开会话的 id 不在 store 里，所以 `agents.create({ meta: { agentPreset } })`
能一步把只读工具集定死——只读从「劝」变成「强制」。

### 复盘读的是什么

DSH 把会话事件写在
`~/.dsh/sessions/<项目>/<会话id>/session.v4.jsonl.zstd`，**本来就有固定位置**，
不需要导出。插件直接读它，提炼成每轮的过程数据：

```
共 11 轮 · 模型产出 101.3k tok · 末尾上下文 1048.6k tok ·
226 次工具调用（1 次失败）· 70 次模型重试 · 压缩 0 次 · 回退 0 次

第 1 轮 | 167 步 195 工具 | 产出 75.0k tok 上下文 1005.8k | 11097.4s  ⚠1 错 ↻32 重试 | 【27省全量横评 · 待测会话】
    · 工具: TEAM_MEMBER_LIMIT
```

需要细节时，复盘会话可以调 `read_session_log` 工具回查原始事件
（按轮次、按类型筛），不必把 7 MB 原始日志塞进上下文。

### 两个必须知道的陷阱

**1. 日志是多帧 zstd，只能逐帧解压。**

一个 2.6 MB 的日志含 **1433 个 zstd 帧**；而 Node 的 `zstdDecompressSync`
与 `createZstdDecompress()` **都只解第一帧**，得到 223 字节就结束，
**而且不报错**。照单次解压实现，复盘只看到日志开头的 0.003%，
却会给出看似合理的错误结论。本插件按魔数切帧逐帧解，并统计坏帧。

**2. `usage.totalTokens` 不能累加。**

它**每一步都包含完整上下文**（实测第 5 步已经是 7870）。累加会得到
随步数膨胀的假数字——初版算出 8300 万 tok，比真实值虚高约 800 倍。
正确口径：产出 = `outputTokens` 累加；上下文规模 = 最后一轮的最新值。

## 0.3.2 修复 — `session "…" already exists` 的真正根因

前两轮都报这个错（0.3.0 报 `session-2`、0.3.1 报 `session-side-…`）。
0.3.1 我判断成「host 自增 id 与磁盘不同步」，改成自己生成 id——
**方向错了**，所以第二次报错里的 id 变成了我自己生成的那个，问题照旧。

真正根因是**流程本身**：

```
sessions.fork(parent, boundary, childId)   // 子会话进入 store
agents.create({ sessionId: childId })      // ← 又去 prepare(同一个 id)
```

`agents.createAgent` 的第一步就是
`sessions.prepare(options.sessionId, …)`，而 `prepare` 对**已在 store 里**
的 id 直接抛 `session "…" already exists`。fork 已经把子会话放进 store 了，
再 `create` 一次必然撞车——与 id 怎么生成毫无关系。

修法：**只 fork，不再建 agent**。首条提问改走

```
subagents.queuePrompt(parentAgent, childId, content, { kind: 'user' })
```

它在官方实现里是「活跃就投进 inbox，不活跃就 cold resume」：

```js
const activation = this.activations.get(childId)
if (activation === undefined) return this.coldResume(parent, childId, …)
```

也就是说宿主会在收到投递时自己把这个子会话拉起来、按它自己的 header
建立 agent。我们既不用建 agent，也拿到了正确的「人写的提问」归属。

构建校验里钉了一条断言：`agents.create` 不许再出现在工厂代码里。

## 为什么复盘不 fork（0.3.x 的历史限制，0.4.0 已解决）

0.3.x 想给复盘会话挂只读预设，两条路都被堵：

1. `sessions.fork` 的 `meta` 只有 `cwd`/`parentSession`/`isSeeded`，
   不接受 `agentPreset`；
2. 事后只能靠 append `agent-preset/selected` 事件切，而官方对它加了锁——
   会话一旦开始过（`lastTurn > 0` 或有未闭合 turn）就抛
   `agent-preset/locked`。fork 出的子会话继承父会话的 turn 历史，
   必然已经「开始过」。

0.4.0 的解法是**根本不 fork**：新开会话的 id 不在 store 里，
`agents.create` 不撞 `already exists`，`meta.agentPreset` 也真正生效。

代价是不继承父会话的对话——但复盘本来就不需要对话，
它需要的是**过程事实**，那从日志文件里读更准、更省。

`docs/session-review-preset.yml` 是这份只读预设的源稿。

## 0.3.1 修复 — 复盘按钮图标几乎看不见

主题变量只能用已发布的 token catalog（`Theme.listTokens` 共 14 个）。
首版用了 `--dsw-alias-label-tertiary`、`--dsw-alias-interactive-bg-hover`、
`--dsw-radius-sm` 等 catalog 外的名字，它们在出厂主题上解析不出值，
浅色主题下退化成几乎看不见的浅灰。

修法：全部换回 catalog 内的 token，尺寸写固定值。
构建校验里新增一条断言，防止再次越界。

## 为什么是旁路会话

主会话的任务流是连续的：一轮接一轮，上下文越滚越长。以前想「顺便问一句」
只有两条路——发到主会话里（打断任务、污染上下文），或者自己开新会话
（丢失全部上下文，得重新交代背景）。

旁路会话是第三条路：`fork` 主会话的前缀得到子会话，子会话有完整上下文、
有自己的 agent 和对话流；主会话既没被打断，也不会收到子会话的任何内容。

## 入口一：选中追问

在会话里选中一段文字 → 点浮动按钮 → 卡片里补问题 → **开侧栏追问**。

- 侧栏会话继承到「当前最新一条」为止的全部上下文；
- 「引用 + 你的问题」会作为第一条消息直接发出去，不用再粘一遍；
- 沿用主会话的预设与模型（问完即弃，不需要只读那一套）；
- 主会话继续跑，侧栏问答不写回主会话的模型上下文。

卡片上仍保留**存入本会话**（原行为）：把引用追加到当前输入框草稿，
由你自己决定何时在主线里发。两个按钮分工明确：
「这段我要在主线讨论」用前者，「问一下但不打断手头活」用后者。

没有侧栏服务时（极少数宿主构建）自动隐藏侧栏按钮，Enter 退回原行为。

## 入口二：会话头复盘

会话头右侧新增一个时钟图标按钮 → **复盘本会话**。

点它会发生三件事：

1. 插件读取该会话的日志文件（`~/.dsh/sessions/…/session.v4.jsonl.zstd`），
   逐帧解压后提炼出每轮的过程数据；
2. 在只读预设下**新开一个会话**，把身份边界、过程数据、复盘协议
   一起作为第一句话注入；
3. 那个会话挂在右侧栏，可以随时用 `read_session_log` 回查原始事件。

这正是「复盘不占用工作区对话任务」的落实方式：

- 主会话任务流不被打断，也不被复盘内容污染；
- 复盘会话的工具集是只读的，即便跑偏也碰不坏工作区；
- 复盘结论由人带回主会话，不自动写回。

## 技术要点

| 事项 | 做法 |
|---|---|
| 追问：继承上下文 | `sessions.fork(parent, undefined, childId)`（显式 id，避免自增撞车） |
| 追问：投首条消息 | `subagents.queuePrompt(parent, childId, content, { kind:'user' })`——活跃投 inbox、不活跃 cold resume，所以不必自己建 agent |
| 复盘：只读强制 | 新开会话 + `agents.create({ meta: { agentPreset } })`；不 fork，因为 fork 会让 `agent-preset/locked` 卡死预设 |
| 复盘：读日志 | Node 内置 zstd，**按魔数逐帧解压**（单次解压只拿到第一帧且不报错） |
| 复盘：查细节 | `read_session_log` 工具，按 turn / type 筛选，单次上限 60 条 |
| 右侧栏渲染 | 自注册 tab 类型 + 资源协议，正文渲染官方 `conversation.content` 工厂（`variant: 'embedded'`） |
| 浏览器↔宿主 | 同源 POST `/dsh-side-ask/rpc`，回环 + confirm 双重门禁 |

**两个关键的坑**：

1. `sidebar.chat.conversation` 是 single 插槽，官方子代理对话已经占用。
   `SlotCore.register` 对 single 插槽遇到同优先级占用会直接抛异常（不是覆盖），
   插件会加载失败。所以本插件声明并使用自己的子插槽 `side-ask.conversation`。

2. `agents.create` 内部第一步是 `sessions.prepare(sessionId)`，对已在 store 里
   的 id 直接抛 `already exists`。所以「先 fork 再 create」必然失败——
   追问走队列投递，复盘走新开会话，两条路都不碰这个陷阱。
   构建校验里有断言分别锁住两条路的写法。

## 安装与升级

插件已通过 `link:` 挂在 desktop profile，升级只需在源码目录构建：

```bash
cd D:/trae-solo/DSH/dsh-selection-ask
npx tsc -p tsconfig.json && npx tsc -p tsconfig.client.json && npx tsdown
```

host 半新增了 `inject: ['webServer', 'sessions', 'agents']`，
**必须重启桌面版**才生效（client 半刷新页面即可）。

验证：

```bash
node test/side-ask.test.mts     # host 半单元测试（13 项）
node ../../docs/check-plugin-build.mjs   # 构建产物完整性
```

## 回滚

0.2.2 的产物备份在同目录 `lib.bak-20261012-191908/`。
把里面的三个文件拷回 `lib/` 再重启即可完全回到旧行为。
