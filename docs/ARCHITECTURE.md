# 架构契约（Architecture Contract）

> 版本 0.7.14 · 由 `scripts/verify-architecture.ts` 机械执行，不是建议。

这份文档描述**约束**，不是描述现状。现状由 `npm run verify:arch` 打印：`156 files · 444 imports · 18/18`，**零个已声明环**。

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

## 八、`server.ts` 拆完了（0.7.14）

`panel/server.ts` 从 **1566 行降到 970 行**，账本里那条例外已经删除。

拆的依据不是行数，是**职责**：`server.ts` 路由消息，`handlers/run.ts` 拥有**进程**。

| 搬走的 | 去哪 | 为什么 |
|---|---|---|
| `handleTerm` / `handleRunScript` / `handleRun` / `handleDebug` / `handleDebugCmd` | `panel/handlers/run.ts`（602 行） | 这五个是唯一 spawn 子进程、持有 DAP 会话的处理器；`server.ts` 只做分派 |
| `ConnState` / `stateFor` / `connState` | `panel/conn-state.ts`（55 行） | 两边都要它；放在任一边，另一边就得反向 import，产生文件级环 |
| `dbgVarsReduce` / `dbgVarsReduceRecord` / `collectStopState` / `execAsync` | 随 `handleDebug` 一起走 | 只被它用 |

顺带收紧了连接生命周期：`takeConnection(conn)` **删除并返回**状态，关闭回调不再需要"读一次、删一次"两步——原来如果 `st` 为空就漏删，现在不可能。

## 九、还没做的

1. **`panel` 仍是 27 个文件** —— 超过 25 的预算，例外还在。它是一页一个 UI 加服务端，切法应该是"按页"，不是按行。
2. **`WorkspaceService.ts` 1229 行** —— **超预算**，靠例外活着。它是"语言、LSP、缓冲区、注册表镜像"四件事捏在一个对象里；拆它是设计改动，不是搬文件。
3. **阶段 11 归因引擎**（CUSUM + Welch t + Cohen's d + 二分）—— `handlers/attribution.ts` 已有骨架。
4. **IDE Markdown 预览窗格 / outline（#40）**、**`verify-exec.ts`（#45）**。
