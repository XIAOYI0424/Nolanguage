# 实时调试观测台（Debug Observatory）设计方案

> 版本 0.2 · 2026-11-01 · 状态：M0 + M1 已交付，**独立应用形态**
> 目标读者：维护这个仓库的人（不是评审委员会）

---

## 零、交付形态：独立应用（0.7.7 决定）

这个工具**不是** IDE 里的一个页面，而是独立软件：

- 入口是命令行 `ndebug <script.py>`，产物是 `dist/NDebug.exe`（Node SEA 单文件，约 84 MB，零依赖）；
- 界面是它自己起在 `127.0.0.1:<port>` 上的自包含页面，跟着目标程序生灭；
- Nolanguage 内置的那套调试保持"基础"不变（断点/单步/变量面板走 DAP），两者**互不依赖**：ndebug 不 import 面板、面板不 import ndebug。

理由：观测台的价值在于"随时开着"。绑在 IDE 上意味着必须先开 IDE、先打开项目；独立 CLI 意味着 `ndebug app.py` 一行就能看，也能挂在别人的脚本里。

代价：多一个 84 MB 的产物、多一条发布链。接受。

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
| **M0**（已交付） | `protocol`/`serializer`/`sampler` 纯逻辑 + 套件 + Python 通道探针 | 36/36；探针把真实 Python 进程的栈写到 NDJSON |
| **M1**（已交付） | 完整 Python agent（栈 + 实时局部变量 + 监视 + 按需快照 + 异常）、`session`、三栏页面、WS 接入、**独立 CLI + 单文件 exe** | 33/33 端到端：attach → 热栈 → 局部变量 → 页面加 watch 拿到真实值 `3` |
| **M2**（已交付） | JS agent（inspector 窗口采样）、快照 diff | JS 示例同样可见；diff 在真实 WS 上返回条目（46 + 5 条断言） |
| **M3**（已交付，路线改了） | Go 改为**轮询 pprof**（无注入）、`/perf` 时间窗互跳 | 44 条 Go 断言（含真实程序 attach）；12 条链接/窗口断言 |
| **M4**（已交付） | 大对象压测、会话录制回放、脱敏可配 + 录像脱敏导出 | 29 + 36 + 29 条断言全绿 |

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

## 十一之二、快照 diff 与录制回放（M2/M4 的三个决定）

### diff：先说清"哪里没比"

三处刻意的选择，每一处都是"这地方可以撒谎"的入口：

1. **截断的子树是 `unavailable`，不是 `removed`。** 两边都在深度/数量上限停下时，那两个值从来没被比较过。说"变了"是编造，说"没变"也是编造。所以它自成一类，并把整个结果标成 `incomplete`——**只有 `incomplete` 为假时，"没有差异"才是结论**。
2. **序列按内容对齐，不按下标。** 往列表头部插一项会让后面每个下标都移位，按下标比会把整张表报成"全变了"，而真正的那一处改动反而看不见。用有界 LCS 先配对相同的项，再把空隙当成增删。
3. **路径指向 after 树。** 用户看的是当前状态，照着路径去 Inspector 里找必须找得到。被移位的那一项，原位置放在 `pathBefore` 里而不是丢掉。

实现上踩到一个隐蔽的坑：`a.map(sigOf)` 会把**数组下标当成第二个参数**（`map` 回调是 `(element, index, array)`），于是每个元素的签名深度不同、LCS 按错误指纹配对。表现是"看起来有结果，但配对是错的"——比崩溃难查得多。

### 录制：文件就是线上格式

`.ndlog` = 一行 `rec-meta` 头 + agent 的原始 NDJSON。回放把同样的行喂回同一个解析器，所以：

- 协议一改，旧录像**立刻**解析失败，而不是被静默重新解释；
- 录像可以用 `grep` / `jq` 直接查，也可以拿去做别的分析；
- 页面不需要任何"回放模式"的渲染代码。

两个必须处理的细节：

- **token 要录。** 录制里的 `hello` 带着原会话的 token，回放会话若随机生成新 token，会在握手处拒绝自己的录像（实测：样本进来了，`target` 却是 `undefined`）。回放用录像里的 token 构造会话。
- **写失败必须只是"关掉录制"。** 磁盘满、文件被占、没权限——都不能反过来影响观测本身。录制器吞掉所有写入异常并记录原因，会话继续跑。

### 压测暴露的三个真 bug

| 症状 | 根因 | 修法 |
|---|---|---|
| 一个 10M 元素的 `Float64Array` 快照花了 **263 ms / 151 MiB** | `Array.from(arr)` 复制了整个缓冲区，只为显示 50 个数 | 按下标读前缀 |
| 目标进程每 2 秒分配 20 万个字符串 | Python agent 用 `list(raw.keys())` 拿全部键，只为前 50 个 | `len()` + 惰性迭代 `raw.items()` |
| **一个 300 KiB 的快照直接杀死会话** | 超长行被判为 `fatal`，且读缓冲超过 2×上限就 `reject` | 超长行改为计数后丢弃（`oversized`），未完成行在 1 MiB 后放弃并在下一个换行处重新对齐 |

第三条是这次压测最重要的产出：**观测工具在被观测对象出问题时才最需要，所以"一条坏数据 = 会话结束"是最不能接受的失效方式。**

引擎侧还补了一个 20,000 节点的树预算（agent 自己是 4,000）：预算在**遍历时**扣，耗尽即停止添加子项并把余量记进 `more`——如果改成"每个剩余元素返回一个 `trunc` 叶子"，树会和被拒绝的载荷一样大（实测 50k 仍是 50k）。

## 十一之三、Go、脱敏、导出、互跳（0.7.11）

### Go：换一条路，而不是硬做注入

原计划是"编译期 agent"。真做下去会发现它要求用户改 `go build` 的调用方式（`-toolexec`），对 CI 里的构建脚本是侵入性的，而且换一个 Go 版本就可能失效。

改走 pprof：**任何挂了 `net/http/pprof` 的程序，都会用一份文本 dump 回答 `/debug/pprof/goroutine?debug=2`**。轮询它就能拿到每个 goroutine 的完整栈，不需要碰用户的构建。

代价写清楚，不藏：轮询不是进程内采样；只有栈没有值（`caps: ['stack']`）；dump 里包含产生 dump 的那个 goroutine。

最后一条是真踩到的：不滤掉 `runtime/pprof.writeGoroutine*` / `net/http/pprof.*`，"最热栈"永远是观测台自己的 HTTP handler。而且过滤必须在**缩短函数名之前**做——`shortFunc` 把 `net/http/pprof.Index` 变成 `pprof.Index`，之后再判断就丢了上下文。这和 Python/JS agent 过滤自身是同一个坑，第三次。

另一个只有真实 dump 才暴露的细节：函数名带参数表（`main.work(0x7ff7...)`），参数里全是地址。不剥掉的话，同一个函数的两帧看起来都不一样，热栈永远合并不了。

`ndebug app.go` 不是报错，是**操作指引**：两行改动 + 要跑的命令 + 明确说"没有 locals"。

### 脱敏：两张表，白名单优先

旧实现是两份硬编码的名单（Python 一份、JS 一份），两个方向都会错：

- **漏**：`sessionid`、`x-api-key` 不在名单里，改不了；
- **误伤**：`token_count` 命中 `token` 被隐藏，而这正是有人想看的那个数。

新规则两张表：`names`（命中即隐藏）与 `allow`（命中即放行，**无条件优先**）。三层来源：默认 → 配置文件 → 命令行。`names` 只能加不能减——配置文件无法把 `password` 从名单里去掉，那正是这个功能最不该允许的错误。

规则通过 `hello-ack` 下发。这里原本是个死配置：引擎一直在发 `redact`，两个 agent 从来没读过。现在两边都读，测试用真实进程验证（`api_token` 因白名单可见、`price` 因自定义名被隐藏）。

### 导出：不猜，只报告

`--sanitize` 做三件事：删 token（header 与 `hello` 各一处）、用**当前**规则重新脱敏所有值、按 `--scrub` 正则清字符串。它不"找看起来像密钥的东西"——一个会静默漏掉的启发式，比一个用户明确配置的规则更危险，因为它制造虚假的信心。

不覆盖输入文件：原始录像才是唯一能用更好规则重新脱敏的东西。

没有 `--scrub` 时字符串里的密钥会留下，报告里的 `0 values scrubbed` 就是在说这件事。

### 互跳：窗口，不是 id

两个工具看同一分钟：ndebug 知道**代码在干什么**（栈 + 时间戳），`/perf` 知道**引擎在干什么**（指标 + 时间戳）。它们没有共同的 id，唯一诚实的连接是时间窗。

所以链接带 `from`/`to`/`src`，`/perf` 顶栏显示窗口并把**趋势图**裁到那一段。三处边界写在页面上：KPI 总计不是窗口内的；没有客户端时间戳的趋势行标 `windowed: false` 并计数；引擎没在跑就没有链接（探测 `/health`，800ms，不拖慢启动）。

趋势的时间戳是页面自己的接收时间。服务器播种的历史没有时间，标 `0` 而不是猜——**一个错的锚点比一个承认的空缺更糟**。

## 十二、已交付与下一步

M1 实际交付的内容（与上面的计划有两处偏差，都是对的）：

1. `session.ts` —— 监听 + token 握手 + 环形缓冲 + 按需聚合（页面拿到的是折叠后的视图，不是原始样本流）。
2. Python agent —— 栈、实时局部变量、监视、按需快照、异常钩子。
3. `ui.ts` + `assets/debug-app.js` —— 三栏页面（Watch / Live stacks / Inspector）。
4. `main.ts`（库）+ `cli.ts`（入口）+ `build-ndebug.mjs`（单文件 exe）。

**偏差一**：原计划把页面挂在 Nolanguage 的 `/debug` 路由上；改成了独立应用（见第零节）。
**偏差二**：原计划监视只在"最内层帧"求值；实测发现 `order.items` 在 `work()` 里会 `NameError`，改成**沿调用链合并命名空间**（内层优先）——这才是用户对"变量"的直觉。

M2 / M4 的交付（与计划一致）：

1. **JS agent** —— `--require` 注入，inspector 500 ms 窗口采样，过滤 Node 内部帧与 agent 自身调用。
2. **快照 diff** —— `diff.ts`（纯函数）+ 页面上的 `baseline` / `diff` 按钮。
3. **大对象压测** —— `verify-stress.ts`，29 条断言，含目标进程内的开销。
4. **会话录制回放** —— `--record` / `--replay` / `--speed`，文件即线上格式。

0.7.11 的交付：Go（pprof 轮询 + 指引）、脱敏可配（两张表 + 三层来源 + 下发到 agent）、录像脱敏导出、`/perf` 时间窗互跳。

下一步（按价值排序）：

1. **Go 的编译期 agent** —— 现在的 pprof 路径拿不到值，也拿不到行级信息；真要这些只能进构建链。
2. **`scripts/` 的类型检查** —— `tsconfig` 只 `include: ["src"]`，40 多个验证脚本从来没被 `tsc` 看过（实测 111 个存量错误）。这跟"vitest 静默丢测试文件"是同一类问题：**基建本身没有守卫**。
3. **`/perf` 的 KPI 也跟随窗口** —— 现在只有趋势被裁，总计仍是当前 digest，横幅只能说清楚而不解决。
4. **脱敏的按值匹配** —— 现在只有名字与正则；"这个字符串和某个已知密钥相等"需要用户提供密钥来源。
