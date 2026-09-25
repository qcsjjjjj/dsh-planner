# 设计与实现说明

这份文档承载**开发原理**：架构、数据结构、以及若干"为什么是这样"的取舍。
面向使用者的功能介绍在 [README](../README.md)。

---

## 1. 它怎么嵌进产品

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

## 2. 两半一包，宿主半边零依赖

| 半边 | 入口 | 说明 |
| --- | --- | --- |
| 宿主（node） | `lib/index.js` | cordis 插件；提供 7 条 HTTP 路由 + 5 个模型工具 |
| 浏览器 | `client/client.js` | **经典脚本**（`window.__ModuleLoader__.load`），不是 ESM |

宿主半边**只 import `node:` 内置模块与相对文件**，这不是风格偏好而是硬约束：
`link:` 安装的插件被 Node 按 realpath 解析，裸包名一律 `ERR_MODULE_NOT_FOUND`
（`.dev/probe-resolve.mjs` 实测，从真实路径与 profile 符号链接路径都一样）。
相对导入不受影响，因为它不查 `node_modules`。

## 3. HTTP 路由

`dsh plugin` 装好后由宿主半边注册，全部是 `kind: 'exact'`：

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-planner/ping` | 自检：插件是否已 apply、存储根在哪、已注册哪些工具 |
| `GET /dsh-planner/state?from=&to=` | 一次取回区间内所有计划（含重复展开）与宿主认为的"今天" |
| `POST /dsh-planner/save` | 新建或更新（带 `scope`：仅此一次 / 整个系列） |
| `POST /dsh-planner/delete` | 删除一条，回传撤销操作 |
| `POST /dsh-planner/toggle` | 勾选/取消完成 |
| `POST /dsh-planner/wipe` | 清空一天（一键躺平），回传撤销操作 |
| `POST /dsh-planner/undo` | 撤销：显式给 `ops`，或由宿主记住"最近一次" |

POST 可用是实测结论：`dsh-github-accel` 的同类 exact 路由对 POST 返回 200；
`dsh-balance-tracker` 之所以对 POST 返回 405，是它自己的 handler 主动拒绝，不是承载层限制。

## 4. 落盘格式

```
~/.dsh/storages/planner/plans/<YYYY-MM-DD>.json   单次计划（recurrence 为 null）
~/.dsh/storages/planner/series.json               重复系列的定义
~/.dsh/storages/planner/undo.json                 最后一次破坏性操作（供无参撤销）
```

单次计划每天一个文件：

```json
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

**为什么重复系列要单独一个文件**：重复系列的"某一次发生"散落在许多日期上，而**系列定义本身
不属于任何一个日期**。放进日期文件后，躺平（规格要求"只跳过该日、系列保留"）就必须小心翼翼地
绕开它；放进独立文件后，**躺平的可达范围天然不含系列定义，这条规则由结构保证**，不是靠记性。

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
  星期几重复，界面会实时提示"从 … 起，每周三"。
- `until` 为 null 表示永不结束。
- `exceptions` 的三种键对应三种"只作用于这一次"的操作：**跳过**、**按天完成**、**覆盖**。
- 展开出的实例带 `seriesBase`（系列自身的值，**未**叠加当天覆盖）。编辑"整个系列"时必须用它，
  否则会把某一天的临时改动悄悄写成整个系列的新定义。

**写入原子性**：临时文件 + `fsync` + 同卷改名，所以崩溃时只会看到旧文件或新文件，
不会看到半个文件。解析不了的文件会被改名成 `<date>.json.corrupt-<时间戳>` 留档，然后按空处理
——不静默丢数据，也不让一天坏掉拖垮整个区间。**单日读取是严格的**（读坏了如实报错），
**区间读取是宽容的**（跳过坏的那天，其余照常渲染）。

## 5. 数据模型里两条刻意的限制

1. **单次计划不能就地改成重复计划**——宿主明确拒绝，界面也不给入口。那份记录住在日期文件里、
   展开逻辑不认它，默默接受会造出一个永不重复的计划（一个界面上看不出来的静默失效）。
2. **重复计划必须保留一种重复方式**。把"重复"改成"不重复"会被拒绝：那条系列一旦脱离展开逻辑，
   就会从它那个可能很遥远的锚点日开始变得不可见。要停止重复请设截止日期或删除整个系列。

## 6. 锚点当天不一定发生（一个真踩过的边界）

「工作日」规则锚在**周六**时，那天本来就不该有这条计划。`save` 曾经把 `expandSeries` 的
`null` 直接回出去，后果有两个：界面"创建成功却什么都不出现"，而模型工具拿它渲染直接崩。

现在 `save` 对系列**永不回 null**：它回一份系列形状的计划，外加 `occursOnAnchor` 与
`firstDate`（首次发生的日期；`until` 早于第一个合法工作日时为 `null`）。界面会在浮窗里
提前提醒，工具也会在结果里写明。

## 7. 模型工具

宿主半边向 `ctx.tools` 注册 5 个工具，**每个会话自动可见**，不需要任何名单或开关。
命名、描述与参数见 `lib/tools.js`；使用者视角的用法见 [README](../README.md)。

### 7.1 ⚠️ 模型看到的只有 `render`，看不到返回值

这是实机验收撞出来的、也是最容易设计错的一点：**模型只拿到 `output.render` 产出的文本**，
拿不到 `execute` 返回的结构化值。任何"让模型把某个句柄传回来"的设计都是断的——
第一版的 `planner_undo` 要求把 `undo_token` 传回来，而那个 token 从未出现在模型可见的任何地方，
于是撤销对整个 Agent 不可达。

修法不是把上千字的 JSON 塞进 `render` 让模型照抄（内容可能很长，不可靠），而是把
**"最后一次破坏性操作"落盘到 `undo.json`**，让 `planner_undo` 不带参数就能撤销。
撤销成功后记录被清掉，所以每次只用一次。

**一般教训**：任何需要在后续调用里被引用的东西，必须出现在 `render` 的文本里，
或者由宿主自己记住——不能只放在返回值里。

### 7.2 四条按证据做的决定

1. **零 import，参数手写 raw JSON Schema。** `ctx.tools.register()` 接受**普通对象**，
   而且只会校验 `output.schema`——`defineTool` 那套作者 DSL（`required: true`）会先被编译成
   别的形状，**不能手写**。已有一个正在运行的先例：`dsh-workflow-cards` 用同一手法注册
   `run_saved_workflow`。
2. **`planner_undo` 必须能不传参数调用**（原因见 7.1）。
3. **`planner_clear` 要 `confirm: true`。** 本会话的审批提示是**禁用**的（需要审批的动作会被
   自动拒绝），所以走不了审批。改用"参数上的减速带"：模型必须主动写出 `confirm: true`。
4. **更新时未提及的字段一律沿用现值。** 也是实机撞出来的：模型说"把这一次挪到 16 点"时
   不会重复列出重要度，若把未提及的字段默认成 `medium`，就会把原本的"高"静默改成"中"。
   `title` 因此只在**新建**时必填（由 handler 判定，不写进 schema 的 `required`）。

### 7.3 与界面不一致的一处，以及为什么

**工具允许为过去日期新建计划，界面不允许。** 界面上禁用「新建」是为了防手滑；而
"把昨天下午那场会补记一下"是真实且合理的请求，工具拒绝它就等于让这一整类请求做不到。
所以规则改为由**描述**约束使用时机（"仅在你被明确要求补记时"），并由工具**如实回传**
（结果里写明这是为哪个过去日期创建的），让用户在对话里看得见。底层是 `save` 的
`allowPastCreate` 开关，**只影响新建**。

## 8. 开发回路

**改 `client/client.js` 不需要重启、不需要刷新页面。**
`@deepseek-ai/dsh-client-hmr` 无条件挂载，以 500ms 轮询每个 client 图的
`artifactBaseline`，而它监视的文件正是 `exports["./client"]` 解析出的那个文件。
改动 → ~500ms 后 `rebuilt()` → SSE `/plugins/events` 推 `{type:"rebuilt"}` → 浏览器热替换 fiber。

改 `lib/index.js`（宿主半边）**需要重启**。

`GET /dsh-planner/ping` 回传的 `step` 是宿主半边自报的版本号：客户端用它判断对面是否已经
支持重复计划。**旧宿主会丢掉 `recurrence` 字段**，新建的"每天"会静默变成不重复——
所以界面在那种情况下会直接藏起重复选择器并给出提示，而不是让用户踩进去。

## 9. 离线测试

```sh
node .dev/run-tests.mjs
```

四套，都不需要 DSH、不需要重启、不需要浏览器：

| 文件 | 覆盖 |
| --- | --- |
| `.dev/smoke-client.mjs` | 日历数学（周一起始、跨月补齐、闰年、跨年）、区间计算、排序、重叠判定、表单校验（含重复与截止日期）、重要度配色、词典完整性 |
| `.dev/smoke-store.mjs` | 持久化层：原子写、校验、过去日期边界、撤销语义、损坏文件留档、排序，以及重复计划的三种规则、截止日期、跳过、作用域、按天独立完成、躺平不清系列 |
| `.dev/smoke-host.mjs` | import 真实的 `lib/index.js`，用真实 `Readable` 喂请求体，走完整 7 条路由并检查状态码与响应体 |
| `.dev/smoke-tools.mjs` | 5 个模型工具：结构契约、**用 `dsh-tools` 真实的 `assertSupportedJsonSchema` 校验 `output.schema`**、参数 schema 真的能挡坏参数、以及逐个工具跑真实 `execute` |

`.dev/render-calendar.mjs` 用真实代码渲染文本版日历，便于对着屏幕逐格核对。
`.dev/probe-resolve.mjs` 是模块解析探针，用来验证"link 安装的插件只能 import 内置模块"这条约束。

## 10. 两条按证据而非偏好做的取舍

**1. 持久化用手写的 `node:fs`，不用 `ctx.storageDomain`。**
`ctx.storageDomain` 本身不需要 import 就能拿到，`domainTable(schema)` 的实现也确实只是
`{ valueSchema: schema }`、设施全文只调用 `safeParse(null)` 与 `parse(...)`——理论上可以手搓一个
鸭子类型 schema 糊过去。但那样"设施只会调这三个方法"就成了只会在**重启之后**才被证伪的推断。
改用内置模块是可证明的，且本 profile 里已有一个正常工作的先例（`dsh-balance-tracker`
用同一手法写 `storages/`）。

**2. 只用 `Modal` 一个产品原语，其余手写。**
证据：`Button` 不用——第一方在 `Modal` 的 `footer` 里用的就是朴素 `<button>`，危险动作用
`data-danger`；`Input` 不用——**没有任何第一方插件在用这个原语**；`Toast` 不用——其实现是
`$C({text,icon,anchor,holdMs,onDone})`，没有 action/children 槽位，装不下"撤销"按钮，
所以撤销做成了列表内的可点撤销条。颜色一律取 `--dsw-*` token，无一处硬编码。

## 11. ⚠️ 写 `.ps1` 的坑（踩过，代价是意外重启了一次 GUI）

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

同一根因的另一处表现：往 GitHub API 发 JSON 时用 `Set-Content -Encoding utf8` 会写入 BOM，
导致 `400 Problems parsing JSON`。改用 `[System.IO.File]::WriteAllBytes(...)` 写纯 ASCII/UTF-8 无 BOM。
