# 架构契约（Architecture Contract）

> 版本 0.7.12 · 由 `scripts/verify-architecture.ts` 机械执行，不是建议。

这份文档描述**约束**，不是描述现状。现状由 `npm run verify:arch` 打印：`153 files · 435 imports · 14/14`。

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

## 三、五条规则

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

预算不是为了好看，是为了让"它变大了"在变成问题之前可见。

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
  "budgetExceptions": { "panel/server.ts": "..." }
}
```

**账本只能缩小。** 新增违规 → 失败；已记账的违规变多 → 失败；已记账的违规消失了 → 也失败（逼你删掉过期条目）。

当前账本只有 2 组环：

| 组 | 为什么还没解 | 要解需要做什么 |
|---|---|---|
| `kernel ↔ perf` | `PerfSpine` 自己构造了 command/event/service 三总线来记录内部指标，所以 perf 依赖 kernel；而 kernel 又持有 perf 脊柱 | 给 `PerfSpine` 一个窄的 host 接口，而不是让它造一个 kernel |
| `cli ↔ desktop` | 两个入口共用"语言列表"和"dump"两个纯格式化模块 | 把这两个文件移到 `panel`（或新建 `commands` 切片） |

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

## 七、还没做的

1. **`kernel ↔ perf`** —— 需要 `PerfSpine` 换掉"自建总线"，是设计改动。
2. **`cli ↔ desktop`** —— 两个纯格式化模块的搬迁。
3. **`scripts/` 不在 `tsc` 范围内** —— 43 个验证脚本从没被类型检查过（实测 111 个存量错误）。架构契约能保证"边"是对的，保证不了"类型"是对的。
4. **`panel` 仍是 30 个文件、`server.ts` 1567 行** —— 已记账，不再增长，但没有变小。
