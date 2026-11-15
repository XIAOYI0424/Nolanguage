# 架构契约（Architecture Contract）

> 版本 0.7.23 · 由 `scripts/verify-architecture.ts` 机械执行，不是建议。

这份文档描述**约束**，不是描述现状。现状由 `npm run verify:arch` 打印：`165 files · 475 imports · 18/18`，**零个已声明环**。

---

## 一、为什么要有这个东西

0.7.12 之前，项目"看起来"分层清晰：目录是按 `kernel` / `panel` / `langs` 分的，文件级循环是 0。这个判断是**错的**，而且错了很久：

| 当时以为 | 实测 |
|---|---|
| 文件级循环 0 个 | **3 个**（6 文件环 + 3 文件环 + 2 文件环） |
| 切片之间基本单向 | **8 组互相依赖** |
| ndebug 是独立应用 | 它 `import` 了 `panel/WebSocketServer` |

第一行是**测量工具的 bug**：我的分析器把绝对路径的 value 和相对路径的 key 混用，环检测永远返回 0。一个会说谎的检查器比没有检查器更糟——它给出的是"已验证安全"的错觉。

所以这套东西的第一条设计要求是：**检查器自己必须被测**。`verify-architecture.ts` 先用合成图跑四个自检（2 环、3 环、DAG、绝对路径），再信任真实数据。

---

## 二、模型

### 切片（slice）

`src/` 下的一级目录就是一个切片。`src/` 根下的文件是 `(root)`，只有 `index.ts` 是组合根。

### 层（layer）

每个切片声明一个层号，见 `scripts/architecture.json` 的 `layers`。**层号是意图，不是现状**：图与意图不一致时，必须有人决定改哪一边。

```
0   util · net · assets · git · vendor
1   correlation
2   log
3   store
4   perf
5   kernel
6   runtimes · mcp · lsp
7   langs
8   go · python · markdown · extensions · dap
9   profiler · exec          ← 注：profiler 10 / exec 10 见 json
10  js
11  panel
12  cli · desktop
13  debugtool（独立产品）
14  (root) 组合根
```

层号本身不重要，**方向**才重要：箭头只能朝下。

### 词汇（vocabulary）

一个 **没有任何 import** 的 `types.ts`（或 `src/` 根下的无 import 文件，如 `version.ts`）是**共享词汇**，任何层都可以引用，不受方向限制。

这条不是走后门，是必需品：`util/env.ts` 要构造 `LogEnvironment`，`store` 要持久化 `MetricSummary`，`log` 要记录 `Span`——如果这些形状必须归属于某一层，那就只能制造向上的边。把它们放进"零 import 的数据形状"里，谁都能指向它，而没有谁依赖谁的行为。

**词汇身份是检查出来的**：一个 `types.ts` 一旦长出 import，它就不再是词汇，所有引用它的地方立刻变成违规边。

---

## 三、六条规则

### R1 · 层序

> 切片只能 import **严格更低层**的切片，或它自己。

例外只有一种：`allowedCycles` 里列出的组。组内的方向由账本决定，因为给它们编一个层号是编故事。

### R2 · 无环

> 切片图和文件图都不得包含成员数 > 1 的强连通分量，除非该组在账本里。

并且**反向检查**：账本里列的环如果已经不存在了，也算失败。否则账本会慢慢腐烂成一堆"曾经如此"的谎言。

### R3 · 词汇

> 零 import 的 `types.ts` 是共享词汇，任何层可引用；非零 import 的 `types.ts` 必须在账本里说明。

### R4 · 产品边界

> `debugtool` 是独立产品，只能 import 账本里给它列的切片（`util` / `net` / `assets` / `vendor`），永远不能 import 应用外壳或内核。

这条是**产品级**的：ndebug 要能单独构建、单独发布，不因为 IDE 改了 `panel` 就跟着坏。

### R5 · 预算

> 单文件 ≤ 1200 行，单切片 ≤ 25 个文件；超了必须在 `budgetExceptions` 里写理由。
> **例外也有寿命**：一条例外如果对应的文件/切片已经不再超预算，构建失败，直到你把它删掉。

预算不是为了好看，是为了让"它变大了"在变成问题之前可见。0.7.14 加了"例外必须仍然成立"这一半——原来只有一半：可以豁免，但豁免永不失效。`panel/server.ts` 就是这样一条过期例外：它从 1566 行降到 970 行之后，账本里那句"WebSocket switch plus HTTP routes"还在描述一个已经不存在的状态。

### R6 · 纯净（`debugtool` 的产品规则）

> `debugtool` 的**线协议与分析模块**（账本 `purity` 列表）不得 import 任何 `node:` 内置模块。

这不是洁癖，是两条可验证的产品承诺：

| 文件 | 为什么必须纯净 |
|---|---|
| `protocol.ts` | 线格式本身。另一个进程、另一种语言的采集器要能只读这个文件就实现它 |
| `serializer.ts` | 把活对象变成线节点。纯净才能在**没有被调试进程**的情况下测它的输出 |
| `sampler.ts` | 折叠栈、卡顿检测：对样本做算术，同样不需要进程 |
| `diff.ts` | 快照 diff，同上 |
| `ui.ts` | 把页面渲染成字符串；谁来服务它，谁就负责传输 |
| `perfLink.ts` | URL 归一化 |

`recorder.ts` **故意不在列表里**：它写文件，那是它的职责。规则的价值在于划出"哪些模块不许碰世界"。

这条规则有自检：`nodeBuiltinsOf` 先对一段同时含静态 `import` 和动态 `import()` 的样本证明自己看得见两种形式，才被允许判断真实代码。一个匹配不到任何东西的正则，会永远报告"纯净"。

---

## 四、账本（`scripts/architecture.json`）

```jsonc
{
  "layers": { ... },              // 意图：谁在谁下面
  "products": { "debugtool": [...] },  // 产品边界
  "allowedCycles": [              // 已知且被接受的环，必须写理由
    { "members": ["kernel","perf"], "why": "..." },
    { "members": ["cli","desktop"], "why": "..." }
  ],
  "budgets": { "maxFileLines": 1200, "maxSliceFiles": 25 },
  "budgetExceptions": { "panel/WorkspaceService.ts": "...", "panel": "..." },
  "purity": { "debugtool/protocol.ts": "...", ... }   // 不得 import node:
}
```

**账本只能缩小。** 新增违规 → 失败；已记账的违规变多 → 失败；已记账的违规消失了 → 也失败（逼你删掉过期条目）。

**当前账本里一组环都没有。** 切片图是一个 DAG。

两笔曾经记在这里的债，0.7.13 还掉了：

| 曾经的组 | 怎么解的 |
|---|---|
| `kernel ↔ perf` | `PerfSpine` 原本强转 `kernel.events as EventBusImpl` 去调埋点钩子。改成 `perf/host.ts` 声明**端口**（`PerfHost`），kernel 侧适配（`onCommand` / `tracer` / `logger` / `events` / `services`）。perf 不再知道 kernel 存在 |
| `cli ↔ desktop` | `cli/` 里 `lang.ts`、`dump.ts` 只依赖 `langs`，却被 `desktop` 反向引用。拆成 `commands/` 切片（层 10）：`desktop → commands`、`cli → desktop`，环消失 |

---

## 五、怎么改代码才不违规

### 加一个类型

1. 它是**数据形状、没有行为**吗？→ 放进所属切片的 `types.ts`，并保证那个文件**零 import**。
2. 它有行为（函数、类、默认值）？→ 放进拥有该概念的切片，按 R1 引用。
3. 它被两个**同层**切片需要？→ 下沉到更低层，或抽成词汇。

### 判断"谁拥有一个类型"

问：**这个概念在哪里产生/持久化/定义语义？**

- `LogCorrelation` → `correlation`（总线产生它）
- `BaselineRecord` → `store`（它是被持久化的行，schema 和类型必须一起改）
- `MetricSummary` → `perf/types`（perf 计算它，store 存它，谁都不独占）
- `RegistryRoot` → `langs/types`（layers 构造、pluginRoots 产出、Registry 消费）

反面教材（0.7.12 之前）：这四类分别躺在 `kernel/types.ts`、`perf/BaselineStore.ts`、`perf/LiveMetrics.ts`、`langs/Registry.ts` 里——**谁用得多就放谁那儿**，于是三个文件互相 import 成环。

### 加一个切片

1. 在 `layers` 里给它一个层号，并想清楚它下面是谁。
2. 如果它要 import 同层或上层的东西，先停下来：要么下沉，要么记账并写理由。
3. 跑 `npm run verify:arch`。

---

## 六、这次实际解掉了什么

| 动作 | 结果 |
|---|---|
| `panel/WebSocketServer.ts` → `net/websocket.ts` | ndebug 不再依赖应用外壳（R4 由违规变干净） |
| `panel/vendor/` → `src/vendor/` | 同上；vendored 代码不再属于任何业务切片 |
| `desktop/embeddedAssets.ts` → `assets/` | 解开 `panel ↔ desktop` 和 `extensions ↔ desktop` |
| 4 个日志类型从 `kernel/types.ts` 移回各自归属 | `log → kernel` 从 4 条边降到 0 |
| `LogSpine` → `kernel/` | kernel 拥有它的脊柱（它本来就 `new` 它） |
| `perf/RingBuffer` → `util/` | 通用数据结构不再住在 perf 里 |
| `Span` / `MetricSummary` / `BaselineRecord` / `RegistryRoot` → 词汇或归属切片 | 解开 `log ↔ perf`、`perf ↔ store`、`langs` 三文件环 |
| 新增 `verify-architecture.ts`（14 条） | 以上都不再能退化 |

从 **8 组互依赖 + 3 个文件环** 降到 **2 组已记账 + 0 个文件环**。

---

## 七、类型也要被约束（`verify-types`）

架构契约保证"边"是对的，保证不了"类型"是对的：`tsconfig.json` 只 `include: ["src"]`，44 个验证脚本从没进过 `tsc`。补上之后有 **108 个存量错误**。

一次修 108 个别人的套件是"安静弄坏东西"的标准做法，所以这里也用账本：`scripts/types-budget.json` 记录每个文件允许携带的错误数。

- 某个文件变多 → 失败
- 出现新文件带错误 → 失败
- 修好了但没下调数字 → **不失败**，但会 `NOTE` 提醒（修东西不该被记账挡住）
- `npm run types:budget` 从当前状态重写（刻意手动：会自我更新的预算不是约束，是日志）

0.7.13 修了 83 条（`verify-pycharm` 的 48 条来自一个 `socket` 可选性，两个页面的 33 条来自 `RegExp` 当布尔用），0.7.14 修完最后 25 条，**预算现在是空数组**——棘轮已经变成硬门：`scripts/` 里任何类型错误都失败。

最后 25 条没有一条是"注释级"的，它们都是**类型擦除后才隐形的真错**：

| 文件 | 错在哪 |
|---|---|
| `debug-completion.ts` | 调 `diagnose(code)`，而签名是 `diagnose(languageId, code)`——它把源码当成语言 id 传了进去。这是调试脚本，不在套件里，所以没人发现 |
| `verify-plugins.ts` | 用 `extra.runnerBytes` 算 `memoryBytes`，而这个字段早已不存在，恒为 `undefined ?? 0` |
| `verify-baseline.ts` | 构造 `PerfEvent` 没写 `category`、`PerfMetric` 没写 `unit`；还直接读 `bs.store`（私有） |
| `verify-extensions.ts` | 把返回数字的命令声明成 `string`，再跟 `6765` 比较 |
| `verify-langplugins.ts` | 四处 `validate(config, 'x')`，而 `validate` 只收一个参数 |

**同一个根因**：类型只在编译期存在，而这些文件从没被编译过。

**顺带发现两件事**：`verify-plugins` 里调用了从未定义的 `skip()`（没有 shell 包装器的机器上会 `ReferenceError`）；两个页面的 30 条"能力检查"把裸正则当布尔 push，**一直无条件通过**——改成 `.test()` 后立刻抓到一条真漂移（`clockOf(s.at)` 在 shell 里而不是 app 里）。

## 八、文档也要被约束（`verify-docs`）

前七条规则管的是代码，管不了**关于代码的说法**。结果是：`README.md` 的验证命令旁注着一个比实际少十几个的套件数；`项目现状报告.md` 开头停在一个七个版本之前的版本号；两份文档指向一个已经搬走的模块路径。

**具体的数字和路径写在 `CHANGELOG.md`（dated）里，本文不引用它们。** 引用一个已经修好的错误数字，会让本文自己变成下一条错误——这条规则对本文同样适用。

**一个过期的数字和一个新鲜的数字长得一模一样**，所以要么检查它，要么别写它。

门禁把文档分成两类，这个区分就是全部要点：

| 类别 | 义务 | 现在有 |
|---|---|---|
| **live**（描述现在） | 提到的路径必须存在、`npm run` 必须存在、声明的版本必须是当前版本、引用的套件数必须是真的 | 6 份 |
| **dated**（带日期的快照） | **允许旧**——快照本来就是旧的——但必须写明日期 | 9 份 |

**每份 Markdown 都必须被归类。** 新文档不在两张表里就失败，因为「没人告诉门禁它存在」正是现状报告能悄悄落后七个版本的原因。

十条检查。**D0 先跑**，因为其余每一条都建立在这一条之上：

| # | 检查 | 抓到过什么 |
|---|---|---|
| D0 | **被归类的文档必须存在** | 删掉一份 live 文档后，原本针对它的所有检查都会静默跳过——这正是这门要防的坑，所以先把它自己堵上 |
| D1 | 每份 `.md` 都被归类 | — |
| D2 | live 文档里的路径存在 | 一个在 0.7.13 搬走的模块路径 |
| D3 | live 文档里的 `npm run X` 存在 | — |
| D4 | live 文档 `> 版本 X` 等于当前版本 | — |
| D5 | live 文档引用的套件数等于真实套件数 | README 的套件数；以及本门禁上线时，新增一个套件让它自己写下的数字立刻过期 |
| D6 | **live 文档不得写断言总数** | README 里那个没人能保持正确的断言总数 |
| D7 | `ARCHITECTURE.md` 的契约数字等于真实数字 | 注入 `999 files` 立即失败 |
| D8 | dated 文档必须写明日期 | 三份评审/决策文档 |
| D9 | `CHANGELOG` 有当前版本的条目 | — |

D6 是最反直觉的一条，也是最有用的一条：**没有任何东西能自动核对断言总数**（除非把全部套件跑一遍，而那就是 `npm run verify` 本身）。所以 live 文档不该写它——写一个自己保不住的数字，就是在制造下一条谎言。

D7 的数字来自 `verify-architecture.ts` 写的 `.tmp/arch-summary.json`。**单一事实来源**，不是复制一份逻辑再比较。文件不在时这门**响亮失败**而不是跳过——会静默跳过的门比没有门更糟。

### 工作流也是说法（`verify-ci`）

`ci.yml` 在仓库里待了六个版本，**一次都没被执行过**。它没有任何明显错误，这正是问题：一个引用了被改名脚本的工作流，要到第一次真正运行时才失败，而在那之前每一次本地绿灯都像是它没问题的证据。

六条检查，全部机械可判：

| # | 检查 |
|---|---|
| C1 | workflow 里的每个 npm 命令都是真实存在的脚本（`npm test` 与 `npm run test` 等价，都要认） |
| C2 | workflow 里每个脚本路径都存在 |
| C3 | 安装用 `npm ci`，不用 `npm install`——lockfile 已提交，`npm install` 会悄悄解析出更新的版本 |
| C4 | 每个 job 至少有一个真正执行命令的步骤（没有步骤的 job 靠什么都不做而变绿） |
| C5 | `continue-on-error: true` 的步骤名字里必须带 "(optional)"，允许失败就得说出来 |
| C6 | 每个 `ci:*` 脚本要么被 workflow 直接调用，要么是由 workflow 也运行的步骤拼成的 |

C6 的第一版是错的：它扫描整个文件，于是**注释里**提到的那个脚本名就让它通过了。注释不执行——只认 `run:` 的值。

### 让「CI 会通过」可执行

每个步骤都写成 npm 脚本，不是内联命令行。这不是洁癖：它让 `npm run ci:pure` 在你自己的机器上跑的就是 CI 的那几条命令。命令只存在于 workflow 文件里时，唯一能运行它的地方就是 runner，这个说法根本无法被检验。

**第一次真正执行 `npm run ci:pure`，它失败了。** `npm test` 退出码 1，而且 `tests/` 里两个测试文件只跑了一个——其中一个文件的 29 个用例被静默丢弃：vitest 写临时目录失败时不报错，只是**丢掉那个文件**，然后把其余的报成通过。同一条门禁逻辑（"跑了个空也算过"）在三个层级上各出现过一次：**套件**、**选择集**、**测试文件**。

现在 `npm test` 走 `scripts/run-tests.mjs`：把 TMP/TEMP/TMPDIR 钉在仓库内，读 vitest 的 JSON 报告，**报告里的文件数少于磁盘上的就失败**。丢一个文件不是通过一个文件。

## 九、`server.ts` 拆完了（0.7.14）

`panel/server.ts` 从 **1566 行降到 970 行**，账本里那条例外已经删除。

拆的依据不是行数，是**职责**：`server.ts` 路由消息，`handlers/run.ts` 拥有**进程**。

| 搬走的 | 去哪 | 为什么 |
|---|---|---|
| `handleTerm` / `handleRunScript` / `handleRun` / `handleDebug` / `handleDebugCmd` | `panel/handlers/run.ts`（602 行） | 这五个是唯一 spawn 子进程、持有 DAP 会话的处理器；`server.ts` 只做分派 |
| `ConnState` / `stateFor` / `connState` | `panel/conn-state.ts`（55 行） | 两边都要它；放在任一边，另一边就得反向 import，产生文件级环 |
| `dbgVarsReduce` / `dbgVarsReduceRecord` / `collectStopState` / `execAsync` | 随 `handleDebug` 一起走 | 只被它用 |

顺带收紧了连接生命周期：`takeConnection(conn)` **删除并返回**状态，关闭回调不再需要"读一次、删一次"两步——原来如果 `st` 为空就漏删，现在不可能。

## 十、按页切（0.7.18）：`ui` 成为独立切片，例外清零

`panel` 一直是 27 个文件，超 25 的预算，靠一条切片例外活着。0.7.18 把它按**职责**切开：

| 留下 | 搬走 | 为什么 |
|---|---|---|
| `server.ts`（路由）、`WorkspaceService.ts`（状态）、`PanelHub`、`FsService`、`Transport`、`flame`、`coverage`、`git`、`samples`、`traffic`、`conn-state`、`demo-commands`、`pythonTraffic`、`pycharm-ui` + `handlers/` | 五个页面 shell（`ui` / `perf-ui` / `extensions-ui` / `plugins-ui` / `profile-ui`）、`assets/`（浏览器端 JS）、`ui/`（PyCharm 的 CSS/壳/客户端分片与 CodeMirror 资产）、`raw.d.ts` | 页面是**纯字符串渲染**：只依赖 `vendor`，不依赖服务器状态 |

`panel` 27 → 21，`ui` 12。**`budgetExceptions` 现在是空对象。**

`pycharm-ui.ts` **故意留在 `panel`**：它要读插件根目录（`langs/pluginRoots`）才能把官方插件清单嵌进外壳，是带文件系统的外壳，不是纯页面。第一版把它一起搬进 `ui`，契约立刻报 `ui(1) -> langs(7)`——那条边说明它站错了地方。

`WorkspaceService.ts` 1229 → 1049 行。切法不是搬函数，是**把投影从状态里分出来**：

- 类的职责是**持有** slot、LSP 客户端、活动运行。
- 把 slot 变成状态栏和插件页消费的 JSON，是那个状态的**投影**。
- 投影搬到 `workspace-wire.ts`，接收一个声明的 `WorkspaceView`（`slots` / `order` / `registry` / `resourceSummary`），类只留四个一行的委托。

形状必须跟着函数一起搬：把它们留在 `WorkspaceService.ts` 再 import 回来，两个文件就互相 import 了，R2 会拒。所以 `Slot`、`LanguageStatus`、`LanguageDescriptorWire` 都在 `workspace-wire.ts` 里，`WorkspaceService` 再 re-export 给老的 importer。

**教训**：这次搬完立刻有两个套件崩了，都不是"测试太脆"，是真的坏了——
- `codemirror-assets.ts` 的相对路径深度差一级（`../../vendor` → `../vendor`），于是 `server → pycharm-ui → codemirror-assets` 整条链在 import 期就死了，`verify-ide` 报的是"server did not start"。
- `verify-pycharm` 里有一处**硬编码** `src/panel/ui/client`，它不在 import 图里，所以 tsc 看不见。

## 十一、按 session 串行化执行平面（0.7.20）

执行平面的 worker 是一请求一响应的协议；Python 还共享 session namespace。`SandboxPool.run()` 过去没有调度层，因此相同 id 的并发请求会：

- 首次同时到达时各自观察到未分配、各 spawn 一个 worker，随后对 `assigned` 的写入互相覆盖；
- 已绑定 worker 上同时运行时，第二个请求的 `busy` 错误被当成 worker 死亡处理，worker 被 recycle 且 session mapping 被删除。

现在 `sessionTails` 给每个 session 单独串行化 `run` 与 `reset`：同一 session 有序，不同 session 仍并行。调用时间从排队时开始计，worker 超时计时仍在 worker 开始执行时启动；日志增加 `queueWaitMs`，返回的总 `durationMs` 包含等待。

active session 的语言归属也被检查：已分配给 Python 的 session id 若改用于 JavaScript 或 Go，会明确报错，不会把源码交给错误 worker。若未来支持跨语言同名 session，应引入复合 key 并同步改 reset/list，而不是悄悄共享字符串 id。

`verify-exec.ts` 增加并发冷启动、namespace 顺序、跨语言拒绝，以及 run→reset→run 排序回归测试（29 → 38 条）。

### Markdown 预览分栏（0.7.21）

预览宽度不再写死为 42%。`.mdsplit` 是 `.codewrap` 与 `.mdprev` 之间的可访问 separator：拖动实时改百分比（24%–64%），方向键微调、Home/End 到边界、双击恢复默认；比例保存到已有 IDE `PREFS`。可视焦点、hover 和拖动状态都使用主题 token；预览关闭时分隔条隐藏，避免留下空隙。回归检查覆盖键盘、拖动、ARIA 当前值和重载恢复。

GitHub runner 的 `ci:install-smoke` 仍待远端验证：当前 checkout 未配置 Git remote，且没有可用 GitHub CLI；没有触发远端工作流。

### 标签页的数据安全（0.7.22）

编辑器 textarea 是当前活动 buffer 的显示面；`BUFFERS[path].content` 必须在每次输入时同步，而不应只在保存后同步。切换文件前后保留 buffer 内容，`dirty` 标记与当前标签一致。

关闭 dirty buffer 时通过 `confirmDialog` 提供 Save / Don't Save / Cancel。保存请求携带 `reqId`；按 path 一次只发一个写入，Save 连点时仅排队最新内容。只有内容对应的 `fsSaved` 回执到达、且 buffer 没有更新版本时才清除 dirty。失败回执不得清空 dirty 或关闭标签。`Close All` 汇总为单个确认；Save All 要等所有目标文件成功后再关组，避免逐文件弹窗互相覆盖。

`verify-pycharm` 覆盖切换保留、取消、保存 ACK、写入失败、显式丢弃、重复保存排队最新内容、多文件批量保存（284 → 304 条）。`Ctrl+F4` 与 File → Close Tab 共用相同的安全关闭路径。

### 顺带修复：Vitest 的 38 个单测曾经一个也没注册

本轮实跑 `npm test`，Vitest 报两个文件失败、**no tests**，不是断言失败。临时在 `describe` 回调里打印日志，看到模块顶层执行了，但 callback 从未进入 collector；去掉 `vitest` 包导入、改用 Vitest 当前 worker 提供的 globals（`globals: true`）后，38 个用例全部回来。测试 API 的包导入与运行中的 collector 不在同一个上下文，是“报告没有 suite”而非模块导入错误的根因。

**结论**：`npm test` 还必须保留文件数守卫；它能抓“少跑了文件”，但不能抓“文件被收集却没有任何用例”。因此单元测试的汇总也应明确给出并核对测试总数，不能只依赖 Vitest 退出码。

## 十二、轻量化（0.7.23）

- SEA release `minify: true`，默认无 inline sourcemap；`NOLANGUAGE_DEBUG_SOURCEMAP=1` 是本地排障开关。注意 Node 本体约 83 MiB 的不可减基础成本；前端 raw string 内部还要各自单独 minify。
- 运行池默认 `SANDBOX_MIN=0`。上限 `SANDBOX_MAX_WORKERS=8`；命名会话达到上限时显式拒绝，不自动丢 Python namespace。只有自动生成的匿名会话可按 LRU 回收；idle 到期默认 5 分钟，`SANDBOX_SESSION_IDLE=0` 关闭会话回收。
- Python LSP eager=false，首次诊断/补全时启动；PANEL_EAGER_LSP=1 仍可统一强制 eager。
- `/` IDE 大 HTML 根据 Accept-Encoding gzip，压缩结果在进程内缓存；其余路由现状不变。
- 子进程每 stream 捕获最多 4 MiB、每次运行最多记录 10,000 telemetry lines；实时回传字节也遵守 capture cap；IDE console DOM 最多 512 Ki characters。过量有明显截断提示，不再无限追加 DOM/log。Live Check 对大于 1 Mi-character 的文件暂停，Run 保留；Find in Files debounce 120ms，限 16 Mi characters 扫描 / 1,000 条结果。
- 语言估算只在 LSP 实际运行时计入 reclaimable 部分；固定 runner/profiler 估算本身已经超过 total budget 时，不再误杀所有活动 LSP。`memoryHint` 仍是估算，不是 RSS。
- SQLite rotation 首轮延迟 60s，此后每 6h 最多 500 行一批；有积压时 1s 后再轮，失败写 warning，下次仍会重试。仅 kernel 自己创建的文件 store 自动维护。
- GitProbe coalesce in-flight forced calls；commit watcher 已取得的 GitInfo 直接给 checkpoint，避免再 spawn Git。

轻量化的验收分开看：SEA 文件大小、安装包大小、IDE gzip 传输大小、启动/首屏时延、总进程 RSS/空闲 CPU 和长运行后 DB/DOM 上界。bundle/minify 只能减少应用 JS 开销，不能去掉 Node runtime；本轮没有 OS 级 RSS / CPU 基准，不能声称这些数字已下降。

### Tauri 包装状态

沿用现有 Rust 壳和 sidecar，不重写。Tauri build 产物可以生成，但其是否可运行必须单独验收：本机历史记录有 WebView2 blank / page-load timeout，打包成功不代表壳已可用。构建尺寸通常还含一份 Nolanguage engine sidecar，不能用 Tauri 安装包体积推断“少了一份 Node”；以本轮 bundle build 与 smoke 实测补录。

## 十三、还没做的

1. **插件市场远程安装 + `trust.signature` 验签**。
2. **`ci:install-smoke` 只在开发机上验证过** —— GitHub runner 上的临时目录与权限策略未实测。

0.7.19 关掉了两项：#40（Markdown 预览窗格 + outline）与 #45（执行平面的验证套件）。#45 装上后立刻抓到两个真 bug —— Python 沙箱**从未真正工作过**：worker 缺 `contextlib` 导入（stdout 重定向不生效，`print` 直接污染帧协议），且 `write_frame` 只写长度头、**从不写 JSON 正文**。两者叠加的效果是每一次 `code.run`（Python）都等到超时，之后整个池子降级。
