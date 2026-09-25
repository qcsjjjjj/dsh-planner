# dsh-planner

[![tests](https://github.com/qcsjjjjj/dsh-planner/actions/workflows/tests.yml/badge.svg)](https://github.com/qcsjjjjj/dsh-planner/actions/workflows/tests.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A **planner board** for the DeepSeek Harness Web GUI: a calendar card plus per-day plan cards, as a
third tab next to 对话 / 轨迹 in the centre column. Adding it changes **no product files and no CSS** —
it rides the public `conversation.view` slot that the built-in chat and trajectory tabs use themselves.

> 界面是中文优先（与 `对话`/`轨迹` 一致），因此本 README 的正文用中文；开头这一段是给外部读者的英文摘要。
> The UI is Chinese-first, matching the built-in tabs, so the body of this README is in Chinese.

**Highlights**

- **Recurring plans** — `daily` / `weekly` (same weekday as the start date) / `weekdays`, with an
  optional end date. Editing or deleting asks **"this occurrence / the whole series"**, and
  completion is tracked **per day**.
- **One-click clear** (一键躺平) empties a day while **keeping recurring series alive** — only that
  day is skipped. This is guaranteed by the storage layout, not by remembering to be careful.
- **Model-facing tools** — the agent can read, create, update, delete and undo plans in conversation
  (`planner_read` / `planner_write` / `planner_delete` / `planner_clear` / `planner_undo`).
- **No build step, no runtime dependencies** — plain ES modules on the host side, one classic script
  on the browser side. Install straight from GitHub.
- **477 offline assertions** across four suites; `node .dev/run-tests.mjs` needs **no DSH installed**
  (the few assertions that use DSH's own JSON-Schema validator skip themselves when it is absent).

## 它怎么嵌进产品

不做任何"改动产品"的事。产品自己把视图标签条做成了一个公开插槽：

- `对话` = 插件 `@deepseek-ai/dsh-client-ui-chat`，注册 `{name:"conversation.view", id:"chat", order:0}`
- `轨迹` = 插件 `@deepseek-ai/dsh-client-ui-trajectory`，注册 `{id:"trajectory", order:10}`
- `计划` = 本插件，注册 `{id:"planner", order:20}`

标签条由 `ui-conversation` 的 `ConversationSessionHeader` 渲染，就是一句 `tabs.map(...)`。
所以本插件**不写一行 CSS**，自动继承字号（13px）、间距（gap 36px）、激活色
（`--dsw-alias-state-business-primary`）和那条 2px 蓝色下划线。

左右侧栏的推挤同样不用管：外层是 CSS Grid
`gridTemplateColumns: ${sidebar}px minmax(0,1fr) ${rightbar}px`，中间列是 `minmax(0,1fr)`，
侧栏开合只换 track，不涉及中间列的 transform/z-index。标签内容只要填满父容器即可。

## Install (from this repo)

```sh
dsh plugin --profile web add github:qcsjjjjj/dsh-planner
# then restart `dsh web` once — the bundle roster is composed at boot
dsh plugin --profile web remove dsh-planner   # uninstall; the tab disappears
```

There is **no build step**: `lib/` and `client/` contain the shipped JavaScript, so a GitHub install
works as-is. `"private": true` in `package.json` is deliberate — it prevents an accidental `npm publish`
while leaving `github:` and tarball installs untouched. Remove that flag if you *do* want to publish.

## 本地开发安装（本机做法）

源码在工作区，`~/.dsh/local-plugins/dsh-planner` 是指向它的 **junction**（单一来源，
和 `dsh-github-accel`、`dsh-hide-open-in-app` 同一做法）。用 junction 而不是直接
`link:` 带空格的路径，是因为工作区路径含空格。

```powershell
dsh plugin --profile web add link:C:/Users/Administrator/.dsh/local-plugins/dsh-planner
# 装完需重启 dsh web 一次（bundle 列表在启动时组装；~/.dsh/restart-dsh.ps1 可用）
dsh plugin --profile web remove dsh-planner   # 卸载，标签随之消失
```

## 开发回路

**改 `client/client.js` 不需要重启、不需要刷新页面。**
`@deepseek-ai/dsh-client-hmr` 无条件挂载，以 500ms 轮询每个 client 图的
`artifactBaseline`，而它监视的文件正是 `exports["./client"]` 解析出的那个文件。
改动 → ~500ms 后 `rebuilt()` → SSE `/plugins/events` 推 `{type:"rebuilt"}` → 浏览器热替换 fiber。

改 `lib/index.js`（宿主半边）**需要重启**。

自检：宿主半边有一个 `GET /dsh-planner/ping`，浏览器半边启动时会 fetch 它并在面板里显示结果——
于是"客户端半边 → 宿主半边"整条链路在第①步就被验证掉。

```powershell
curl.exe -s http://127.0.0.1:3080/dsh-planner/ping
# {"ok":true,"plugin":"dsh-planner","step":4,"storage":"…\\storages\\planner\\plans",
#  "series":"…\\storages\\planner\\series.json","recurrence":true}
```

`step` 是宿主半边自报的版本号：客户端用它判断对面是否已经支持重复计划。
**旧宿主（step < 4）会丢掉 `recurrence` 字段**，新建的"每天"会静默变成不重复——
所以界面在那种情况下会直接藏起重复选择器并给出提示，而不是让你踩进去。

计划的落盘位置就是上面 `storage` 报的那个目录，单次计划每天一个文件：

```
~/.dsh/storages/planner/plans/2026-09-24.json
{
  "version": 2,
  "date": "2026-09-24",
  "plans": [ { "id": "…", "title": "…", "content": "…", "start": "09:00", "end": "10:00",
               "importance": "high", "done": false,
               "recurrence": null, "until": null,
               "createdAt": "…", "updatedAt": "…" } ],
  "updatedAt": "…"
}
```

重复系列另存一处（见下一节）。

写入是"临时文件 + fsync + 同卷改名"，所以崩溃时只会看到旧文件或新文件，不会看到半个文件。
解析不了的文件会被改名成 `<date>.json.corrupt-<时间戳>` 留档，然后按空处理——不静默丢数据，
也不让一天坏掉拖垮整个区间。**单日读取是严格的**（读坏了就如实报错），
**区间读取是宽容的**（跳过坏的那天，其余照常渲染）。

## 分步状态

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| ① | 骨架：标签 + 面板 + 宿主自检 | **已完成**（用户已肉眼确认） |
| ② | 日历卡片（翻月、周一起始、今天、选中、密度圆点） | **已完成**（用户已确认） |
| ③ | 计划卡片列表、方形完成框、新建/编辑浮窗、一键躺平、持久化 | **已完成**（用户已确认） |
| ④ | 重复计划（规则、截止日期、作用域询问、按天独立完成） | **已完成**（用户已确认） |
| ⑤ | 模型工具：Agent 可在对话里读写计划 | **代码完成**，等一次重启生效 |

## 重复计划的存储与语义

系列定义住在 **`<root>/series.json`**，不在任何日期文件里：

```
~/.dsh/storages/planner/plans/2026-09-24.json   单次计划（recurrence 为 null）
~/.dsh/storages/planner/series.json             重复系列的定义
```

分两个文件不是洁癖：重复系列的"某一次发生"散落在许多日期上，而**系列定义本身不属于任何
一个日期**。放进日期文件后，躺平（规格要求"只跳过该日、系列保留"）就必须小心翼翼地绕开它；
放进独立文件后，**躺平的可达范围天然不含系列定义，这条规则由结构保证**，不是靠记性。

```json
{
  "id": "…", "title": "每日站会", "content": "", "start": "09:00", "end": "09:15",
  "importance": "medium",
  "anchor": "2026-09-25",
  "recurrence": "daily",
  "until": null,
  "exceptions": {
    "2026-10-01": { "skip": true },
    "2026-10-05": { "done": true },
    "2026-10-08": { "override": { "title": "站会（改）", "start": "10:00", "end": "10:15" } }
  }
}
```

- `recurrence` 只有三种：`daily` / `weekly` / `weekdays`。`weekly` 按 **anchor 那天**的
  星期几重复，界面会实时提示"按开始那天算：每周三"。
- `until` 为 null 表示永不结束。
- `exceptions` 的三种键对应三种"只作用于这一次"的操作：**跳过**（删除该次）、
  **完成**（按天独立的勾选）、**覆盖**（只改这一天的字段）。
- 删除或编辑时界面会问「**仅此一次 / 整个系列**」，默认的"仅此一次"放在主位（最右），
  破坏性大的"整个系列"用危险色放在左边。
- 展开出的实例带 `seriesBase`（系列自身的值，**未**叠加当天覆盖）。编辑"整个系列"时必须用它，
  否则会把某一天的临时改动悄悄写成整个系列的新定义。

### 两条刻意的限制

1. **单次计划不能就地改成重复计划**——宿主明确拒绝，界面也不给入口。那份记录住在日期文件里、
   展开逻辑不认它，默默接受会造出一个永不重复的计划（一个界面上看不出来的静默失效）。
   想改就删掉重建。
2. **重复计划必须保留一种重复方式**。要停止重复，请设置截止日期，或删除整个系列。
   把"重复"改成"不重复"会被拒绝：那条系列一旦脱离展开逻辑，就会从它那个可能很遥远的
   锚点日开始变得不可见。

### 锚点当天不一定发生（一个真踩过的边界）

「工作日」规则锚在**周六**时，那天本来就不该有这条计划。`save` 曾经把 `expandSeries` 的
`null` 直接回出去，后果有两个：界面"创建成功却什么都不出现"，而模型工具拿它渲染直接崩。

现在 `save` 对系列**永不回 null**：它回一份系列形状的计划，外加 `occursOnAnchor` 与
`firstDate`（首次发生的日期；`until` 早于第一个合法工作日时为 `null`）。界面会在浮窗里
提前提醒「这一天是周末，计划将从下一个工作日开始」，工具也会在结果里写明。

## 模型工具（Agent 读写计划）

宿主半边向 `ctx.tools` 注册 5 个工具，**每个会话自动可见**，不需要任何名单或开关：

| 工具 | 作用 |
| --- | --- |
| `planner_read` | 读一天或一个区间；返回每条的 `id`（后续删/改要用）。无参默认今天起 7 天 |
| `planner_write` | 建或改；可设 `recurrence` / `until`；带 `id` 即更新 |
| `planner_delete` | 删一条（按 `id`，或按唯一 `title`）；重复计划可选只跳过这一次 |
| `planner_clear` | 一键躺平的对应工具；**必须显式传 `confirm: true`** |
| `planner_undo` | **不带参数**即撤销刚才那次删除/清空（`token` 只是可选的精确通道） |

### ⚠️ 模型看到的只有 `render`，看不到返回值

这是实机验收撞出来的、也最容易设计错的一点：**模型只拿到 `output.render` 产出的文本**，
拿不到 `execute` 返回的结构化值。任何"让模型把某个句柄传回来"的设计都是断的——
第一版的 `planner_undo` 要求把 `undo_token` 传回来，而那个 token 从未出现在模型可见的任何地方，
于是撤销对整个 Agent 不可达。

修法不是把上千字的 JSON 塞进 `render` 让模型照抄（内容可能很长，不可靠），而是把
**"最后一次破坏性操作"落盘到 `<root>/undo.json`**，让 `planner_undo` 不带参数就能撤销。
这既可靠，也更贴合用户的说法（"撤销刚才那次"）。撤销成功后记录被清掉，所以每次只用一次。

**一般教训**：任何需要在后续调用里被引用的东西，必须出现在 `render` 的文本里，
或者由宿主自己记住——不能只放在返回值里。

### 三条按证据做的决定

1. **零 import，参数手写 raw JSON Schema。** 本插件是 `link:` 安装的，宿主半边只能 import
   内置模块与相对文件（`@deepseek-ai/dsh-tools` 会 `ERR_MODULE_NOT_FOUND`）。好在
   `ctx.tools.register()` 接受**普通对象**，而且只会校验 `output.schema`——
   `defineTool` 那套作者 DSL（`required: true`）会先被编译，**不能手写**。
   已有一个正在运行的先例：`dsh-workflow-cards` 用同一手法注册 `run_saved_workflow`。
2. **必须有 `planner_undo`，而且必须能不传参数调用。** 界面里删错了有 5 秒撤销条，而**工具没有**
   ——不给自己留退路的删除就是单程票。它不带参数即撤销刚才那一次（原因见上一节）。
3. **`planner_clear` 要 `confirm: true`。** 本会话的审批提示是**禁用**的（需要审批的动作会
   被自动拒绝），所以走不了审批。改用"参数上的减速带"：模型必须主动写出 `confirm: true`，
   而不是顺手调用一个删除就清空一整天。
4. **更新时未提及的字段一律沿用现值。** 也是实机撞出来的：模型说"把这一次挪到 16 点"时
   不会重复列出重要度，若把未提及的字段默认成 `medium`，就会把原本的"高"静默改成"中"。
   `title` 因此只在**新建**时必填（由 handler 判定，不再写进 schema 的 `required`）。

### 与界面不一致的一处，以及为什么

**工具允许为过去日期新建计划，界面不允许。** 界面上禁用「新建」是为了防手滑；而
"把昨天下午那场会补记一下"是真实且合理的请求，工具拒绝它就等于让这一整类请求做不到。
所以规则改为由**描述**约束使用时机（"仅在你被明确要求补记时"），并由工具**如实回传**
（结果里写明这是为哪个过去日期创建的），让用户在对话里看得见。底层是 `save` 的
`allowPastCreate` 开关，**只影响新建**。

## 离线测试

```powershell
node "F:\dsh work part5\dsh-planner\.dev\run-tests.mjs"
```

四套，都不需要 DSH、不需要重启、不需要浏览器：

| 文件 | 覆盖 |
| --- | --- |
| `.dev/smoke-client.mjs` | 日历数学（周一起始、跨月补齐、闰年、跨年）、区间计算、排序、重叠判定、表单校验（含重复与截止日期）、重要度配色、重复规则的措辞 |
| `.dev/smoke-store.mjs` | 持久化层：原子写、校验、过去日期边界、撤销语义、损坏文件留档、排序，以及**重复计划的四种规则、截止日期、跳过、作用域、按天独立完成、躺平不清系列** |
| `.dev/smoke-host.mjs` | import 真实的 `lib/index.js`，用真实 `Readable` 喂请求体，走完整 7 条路由并检查状态码与响应体 |
| `.dev/smoke-tools.mjs` | 5 个模型工具：结构契约、**用 `dsh-tools` 真实的 `assertSupportedJsonSchema` 校验 `output.schema`**、参数 schema 真的能挡坏参数、以及逐个工具跑真实 `execute`（含过去日期补记、作用域、周末锚点、撤销、`confirm` 门槛） |

`.dev/render-calendar.mjs` 会用真实代码渲染文本版日历，便于对着屏幕逐格核对。
`.dev/probe-resolve.mjs` 是模块解析探针，用来验证"link 安装的插件只能 import 内置模块"这条约束。

## 两条按证据而非偏好做的取舍

**1. 持久化用手写的 `node:fs`，不用 `ctx.storageDomain`。**
插件是 `link:` 安装的，Node 按 realpath 解析，非内置的裸模块名一律 `ERR_MODULE_NOT_FOUND`
（`.dev/probe-resolve.mjs` 实测，从真实路径与 profile 符号链接路径都一样）。
`ctx.storageDomain` 本身不需要 import 就能拿到，`domainTable(schema)` 的实现也确实只是
`{ valueSchema: schema }`、设施全文只调用 `safeParse(null)` 与 `parse(...)`——理论上可以手搓一个
鸭子类型 schema 糊过去。但那样"设施只会调这三个方法"就成了只会在**重启之后**才被证伪的推断。
改用内置模块是可证明的，且本 profile 里已有一个正常工作的先例（`dsh-balance-tracker` 用同一手法
写 `storages/`）。落盘路径与设计冻结时完全一致。

**2. 只用 `Modal` 一个产品原语，其余手写。**
证据：`Button` 不用——第一方在 `Modal` 的 `footer` 里用的就是朴素 `<button>`，危险动作用
`data-danger`；`Input` 不用——**没有任何第一方插件在用这个原语**；`Toast` 不用——其实现是
`$C({text,icon,anchor,holdMs,onDone})`，没有 action/children 槽位，装不下"撤销"按钮，
所以撤销做成了列表内的可点撤销条。颜色一律取 `--dsw-*` token，无一处硬编码。

## ⚠️ 写 `.ps1` 的坑（踩过，代价是意外重启了一次 GUI）

**不要往 `.ps1` 里写非 ASCII 注释。** 若文件是 UTF-8 **无 BOM**，Windows PowerShell 5.1
会按系统 ANSI 码页（中文机器上是 GBK）解码，中文注释变乱码；更糟的是，若注释行以多字节
字符结尾，乱码产生的"前导字节"会**吞掉换行符**，把下一行语句并进注释。

实测：一个以 `。` 结尾的中文注释吞掉了紧随其后的 `Start-Sleep -Seconds 90`，
于是本该 90 秒后才关停 GUI 的重启助手在 **2 秒**后就关停了。

自检办法（用 5.1 而非 pwsh 做词法分析）：

```powershell
powershell.exe -NoProfile -Command "[System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw .\x.ps1),[ref]`$null) | Select Type,Content,StartLine"
```

安全的三种写法，任选：**(a)** 注释只用 ASCII；**(b)** 存成 UTF-8 **带 BOM**；**(c)** 用 `pwsh`(7+) 执行。
