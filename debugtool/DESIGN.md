# 实时调试观测台（Debug Observatory）设计方案

> 版本 0.1 · 2026-11-01 · 状态：设计已定，M0 骨架已落地
> 目标读者：维护这个仓库的人（不是评审委员会）

---

## 一、它要解决什么问题

现有调试能力是三块，各缺一角：

| 现有 | 能回答 | 回答不了 |
|---|---|---|
| DAP（debugpy / dlv / node inspector） | 断点处**这一瞬**的栈和变量 | 程序**跑着**的时候栈长什么样 |
| Profiler（cProfile / pprof） | 跑完之后的火焰图和热点 | 现在、此刻、这一秒在干什么 |
| perf spine | 引擎内部命令/事件的耗时 | 用户代码里发生了什么 |

所以这个工具不是"又一个调试器"，而是**运行中程序的三棱镜**：

1. **实时调用栈**——不停程序，看到栈在动（采样，1–20 Hz）
2. **数据结构快照**——任意对象按受控 schema 序列化成可展开的树，两次快照能 diff
3. **变量监视**——表达式按需求值、变化高亮、历史回看

附加（成本低、价值高）：异常流、内存/GC 走势、长任务（> 阈值）标记、与 perf 的 traceId 互跳。

**非目标**（明确写出来，防止范围失控）：
- 不做断点/单步——那是 DAP 的活，重复实现只会做出一半
- 不做 post-mortem 火焰图——`/profile` 已经有了
- 不做远程调试——只监听 `127.0.0.1`
- 不做"自动发现对象"——用户给表达式，工具不猜

---

## 二、为什么是"采样"而不是"插桩"

插桩（每次函数调用都上报）听起来更"实时"，但代价是 10–100 倍的减速，而调试场景里用户经常在跑一个本来就很慢的程序。采样是**固定成本**：10 Hz × 深度 8 × 线程数，Python 实测 < 1% 开销，且不会因为程序逻辑分支多而变慢。

代价是**看不见短于采样间隔的调用**。这不是缺陷，是取舍：观测台回答"现在在干什么"，火焰图回答"总共花在哪"。两者互补，所以工具里直接给出跳转。

---

## 三、架构

```
debugtool/                       ← 门面：设计、样例目标、独立探针
  DESIGN.md                      ← 本文
  README.md
  samples/py/app.py              ← 被观测的示例程序（有嵌套结构 + 慢函数）
  samples/js/app.js
  probes/python_agent_probe.py   ← M0 探针：证明 agent→引擎 的通道

src/debugtool/                   ← 引擎（放在 src/ 内，才能进 tsc 与单文件 exe）
  protocol.ts                    ← 线上格式 + 校验（NDJSON，v1）
  serializer.ts                  ← 安全序列化（深度/宽度/循环/截断）
  sampler.ts                     ← 采样聚合（栈折叠、热点、长任务）
  watch.ts                       ← 路径解析 + 变更检测
  session.ts                     ← DebugSession：监听、握手、背压、环形缓冲
  agents/python/agent.py         ← 注入的 Python agent（文本资源）
  agents/js/agent.js             ← 注入的 JS agent（inspector 采样窗口）

src/panel/debugtool-ui.ts        ← /debug 自包含页面（同 /perf 的形态）
src/panel/assets/debug-app.js    ← Vue 应用
scripts/verify-debugtool.ts      ← 套件
```

**为什么引擎不放在 `debugtool/` 里**：`tsconfig.json` 是 `rootDir: src` + `include: ["src"]`。放到外面意味着要么改 rootDir（影响 declaration 输出布局），要么放弃类型检查——两者都不划算。`debugtool/` 是**门面与实验场**（设计、样例、探针、将来的 CLI 包装），`src/debugtool/` 是**要进 exe 的代码**。这条边界写在这里，避免以后有人问"为什么分成两个地方"。

### 数据流

```
被测程序 ──(进程内 agent)──TCP 127.0.0.1:port──> DebugSession ──> 环形缓冲
                                                    │                  │
                                                    └──WS /debug───────┘
```

- **为什么是 TCP 而不是 stdout**：stdout 是程序自己的输出通道，混进去就要解析前缀，用户 `print` 一行恰好长得像协议就会误判。TCP 是独立通道，且 Python/JS/Go 都自带。
- **为什么不是文件**：实时性要求秒级，轮询文件既慢又要处理截断。
- **端口从哪来**：工具先监听（`port 0` 让系统分配），把 `port` + `token` 通过环境变量交给 agent。

---

## 四、协议（v1，NDJSON）

每行一个 JSON 对象，`t` 是类型，`v` 是协议版本。首行必须是 `hello`，否则断开。

### agent → 工具

| `t` | 载荷 | 说明 |
|---|---|---|
| `hello` | `lang, pid, target, agentVersion, caps[]` | 握手，工具据此选择渲染器 |
| `stack` | `at, tid, frames[{fn,file,line}], state` | 一次采样；`state: running\|blocked\|idle` |
| `snapshot` | `id, at, path, value` | 一次结构快照，`value` 是序列化后的树 |
| `watch` | `at, id, ok, value?, error?` | 一次表达式求值结果 |
| `exception` | `at, tid, type, message, frames[]` | 未捕获异常 |
| `metric` | `at, name, value, unit` | 内存/GC/线程数 |
| `bye` | `reason` | 程序退出 |

### 工具 → agent

| `t` | 载荷 | 说明 |
|---|---|---|
| `hello-ack` | `sampleHz, maxDepth, watches[], redact[]` | 下发采样率、监视表达式 |
| `set-watches` | `watches[]` | 运行中改变监视列表 |
| `snapshot` | `id, path` | 请求一次快照 |
| `bye` | — | 要求 agent 停止采样 |

**版本化**：`v` 不匹配时工具只接受 `hello` 并回 `hello-ack{v:1, reject:"version"}`，然后断开——不会用未知字段去猜。

---

## 五、注入方式（每种语言一条路）

### Python：`sitecustomize` + `PYTHONPATH`

生成临时目录：

```
<tmp>/nlg-debug-<id>/
  sitecustomize.py     # import nlg_agent; nlg_agent.boot()
  nlg_agent.py         # agent 本体（从 src/debugtool/agents/python 复制）
```

启动时 `PYTHONPATH=<tmp>;...`，解释器启动即执行 `sitecustomize`，**不改 argv、不改 `__main__`、不要求用户改代码**。

- 采样：后台线程每 100 ms 调 `sys._current_frames()`，取主线程栈，`traceback.extract_stack` 转成 `frames[]`。
- 监视：`eval(expr, frame.f_globals, frame.f_locals)`，只在用户显式添加时执行。
- 回退：嵌入式解释器（不跑 sitecustomize）时用 `python -u -c "import nlg_agent; nlg_agent.boot(); exec(open('app.py').read())"`。

### JavaScript：inspector 采样窗口

JS 没有"读另一个线程栈"的 API。可行的是 `inspector.Session` + `Profiler`：

```
每 500 ms：Profiler.stop() → 得到 samples(nodeId/timeDeltas) → Profiler.start()
```

把窗口内的样本按 `nodeId` 还原成栈，就是"准实时"。**明确记录这个限制**：JS 是窗口采样，不是连续采样；间隙里发生的调用看不到。用户界面标注 `sampled/window`，不假装连续。

- 注入：`node --require <tmp>/nlg-agent.js app.js`（`--require` 不改变 `__main__` 语义）。
- 监视：`vm.runInThisContext` 求值，或 `eval` 在当前上下文——记录为"在目标进程内执行"。

### Go：编译期（M3）

Go 没法在运行时注入（除非改源码）。两条路：
1. `go run -tags nlgdebug`，靠构建标签引入一个 `_nlg_agent.go`（需要复制源码到临时模块）；
2. 采样用 `runtime/Stack` + `net` 直接写在 agent 里，随程序编译。

M3 再定。**在 M3 之前，Go 明确显示"不支持实时栈，请用 /profile"**——比假装支持好。

---

## 六、安全与限额

这个工具的本质是"在目标进程里执行表达式"，所以边界必须写死：

| 项 | 限制 | 理由 |
|---|---|---|
| 监听地址 | 只 `127.0.0.1` | 不做远程调试 |
| 握手令牌 | 32 hex，一次性，环境变量传递 | 同机其它进程不能随便连 |
| 事件大小 | ≤ 256 KiB/行，超限丢弃并计数 | 防止一个巨大对象把缓冲打爆 |
| 事件速率 | ≤ 500 行/s，超出丢弃并计数（上报 `dropped`） | 背压 |
| 序列化深度 | 默认 6 层 | 深链是 OOM 的主要来源 |
| 单层宽度 | 50 个成员 / 100 个元素 | 同上 |
| 字符串 | 512 字符，超出截断并标记 | 同上 |
| 循环引用 | 检测 → `"[cycle → <path>]"` | 不加检测会无限展开 |
| 自定义类型 | 只读 `__dict__`/`__slots__`/内置容器；**不调 `__repr__`** | `__repr__` 可以执行任意代码、可以读密钥 |
| 表达式 | 只有用户手动添加的才执行 | 不自动跑线上来的表达式 |
| 快照留存 | 200 个 × 256 KiB，环形 | 内存上限 |

`redact` 列表：名字匹配（`password`、`token`、`secret`、`key`）的字段值替换为 `"***"`，在**序列化前**处理，不依赖 UI 遮挡。

---

## 七、数据模型

### 序列化节点（`serializer.ts` 的输出）

```ts
type SNode =
  | { k: 'prim'; t: 'int'|'float'|'str'|'bool'|'none'; v: string }     // v 永远是字符串
  | { k: 'seq'; t: string; n: number; items: SNode[]; more?: number }  // more = 被省略的数量
  | { k: 'map'; t: string; n: number; entries: [SNode, SNode][]; more?: number }
  | { k: 'obj'; t: string; fields: [string, SNode][]; more?: number; cycle?: string }
  | { k: 'trunc'; why: 'depth'|'size'|'unsupported'|'redacted'; t?: string }
```

三条不变量（用测试守住）：
1. **一定能终止**：深度/宽度/元素数都有上限，环有检测。
2. **一定是纯数据**：不含函数、不含迭代器、不含 `__repr__` 的结果。
3. **省略要可见**：`more`/`trunc` 让 UI 显示"还有 37 项"，而不是假装对象就那么大。

### 栈样本聚合（`sampler.ts`）

原始样本不能直接画（10 Hz × 60 s = 600 条）。聚合成"热栈"：

- 按 `frames` 的**函数签名序列**折叠（`a>b>c`），累计出现次数和最近时间
- 输出：`[{ stack: 'a>b>c', hits, share, lastAt, state }]`，按 `hits` 降序
- 长任务：同一栈连续出现 ≥ `stallSamples` 次（默认 5，即 0.5 s）→ 标记 `stalled: true`
- 保留最近 2,000 个原始样本供时间线回看

---

## 八、界面（`/debug`）

三栏，和 PyCharm 的 Debug 工具窗同构，但每栏解决"跑着的时候"的问题：

```
┌───────────────┬───────────────────────────────┬──────────────────────┐
│ 监视 + 快照   │ 实时栈（热栈 + 时间线）        │ 对象检查器            │
│               │                               │                      │
│ ▸ watch 列表  │ ████ main>work>step  42% 3.1s  │ Order #12            │
│ ▸ snapshot 列 │ ██   main>work>sleep 28%      │  id: 12             │
│   12:03:11    │ █    main>io>read    15%      │  items: [3]         │
│   12:03:41    │                               │   ▸ [0] Item         │
│               │ 时间线 ▁▂▃▅▇▅▃▂▁            │   ▸ [1] Item         │
│               │                               │  更多 37 项…         │
└───────────────┴───────────────────────────────┴──────────────────────┘
```

交互要点：
- 点击热栈 → 右侧显示该栈最近一次样本的**局部变量快照**（agent 额外发一次 `snapshot{path:"__frame__"}`）
- 两次快照之间切 diff → 变化的字段高亮（`+`/`-`/`~`）
- 监视项有变化时闪烁一次，不常驻动画（避免干扰）
- 连接状态、采样率、丢弃计数常驻页脚——**观测工具自己的开销必须可见**

---

## 九、里程碑与验收

| 里程碑 | 内容 | 验收（可测） |
|---|---|---|
| **M0**（已做） | 目录、方案、`protocol`/`serializer`/`sampler` 纯逻辑 + 套件 + Python 通道探针 | 套件全绿；探针能把真实 Python 进程的栈写到 NDJSON |
| M1 | Python agent 完整（栈+快照+监视）、`/debug` 页面骨架、WS 接入 | 页面能看示例程序的热栈；监视表达式变化可见 |
| M2 | JS agent（inspector 窗口采样）、快照 diff | JS 示例同样可见；diff 正确标出 `+ - ~` |
| M3 | Go（编译期 agent 或明确降级）、异常流、perf traceId 互跳 | Go 要么有栈要么有明确的"不支持"提示 |
| M4 | 限额/背压/脱敏收口、文档、`nlg debugtool <script>` 一行启动 | 100 MB 对象不炸；`redact` 生效；CLI 可用 |

**M1 的验收线是硬的**：用 `debugtool/samples/py/app.py`（含递归结构 + 慢函数 + 循环引用），页面必须能同时显示"热栈前三"和"该栈的局部变量"，且 60 秒内引擎 RSS 增长 < 30 MB。

---

## 十、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Python 采样线程看不到目标线程栈 | 栈永远是 agent 自己的 | 用 `sys._current_frames()`（返回**所有**线程的当前帧），按 `threading.main_thread().ident` 取主线程 |
| `eval` 监视表达式改变程序状态 | 观测影响被观测对象 | 只读表达式建议；文档写明"求值会执行代码"；`redact` 不解决这个，诚实告知 |
| JS 窗口采样有间隙 | 用户以为连续 | UI 标注 `window`，并在时间线画出空隙 |
| 大对象序列化卡住 agent | 被测程序被拖慢 | 序列化在 agent 的**独立线程**里做，主线程只投递引用；超时 50 ms 直接返回 `trunc{why:'size'}` |
| 协议演进破坏兼容 | 老 agent 连新工具 | `v` 不匹配只回 `reject`，不猜字段 |
| 与 DAP 抢同一个进程 | 端口/信号冲突 | 观测台用独立 TCP；不与 debugpy/dlv 共用连接；两者可同时开（debugpy 用 stdin/stdout） |

---

## 十一、与现有系统的边界

- **不碰 DAP**：`src/dap/*` 一行不改。观测台是"另一个视角"，不是"更好的 DAP"。
- **不碰 perf 存储**：栈样本只进内存环形缓冲；要归档时写 `appDataPath('debugtool/')` 的 JSONL，不进 SQLite 的 perf 表（两者语义不同：一个是采样，一个是记录）。
- **复用**：`appDataPath`、WS 广播、自包含页面骨架（`perf-ui.ts` 的形态）、`verify-all` 的套件约定、`discoverBinary` 找解释器。

---

## 十二、下一步（等你点头）

M1 的实现顺序（每步都能独立验证）：

1. `session.ts`：监听 + 握手 + 环形缓冲（先不接页面，用 `scripts/verify-debugtool.ts` 驱动）
2. `agents/python/agent.py`：栈采样 + 快照 + 监视（对着 `samples/py/app.py` 跑）
3. `debugtool-ui.ts` + `debug-app.js`：三栏骨架，先只接"热栈"
4. WS 接入 `/debug` 路由 + 广播
5. 套件扩到端到端（起 Python 进程 → 页面数据可见）

如果只做一件事，就做 1+2：**通道和 agent 通了，页面只是画图**。
