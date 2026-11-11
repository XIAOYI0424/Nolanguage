# ndebug — 实时调试观测台

看**正在跑**的程序：调用栈、局部变量、任意表达式的值。不停程序、不加断点、不改代码。

```
ndebug app.py
```

一行命令，浏览器打开一个三栏观测台，程序照常运行、照常输出。

---

## 它和普通调试器不一样的地方

| | 普通调试器（pdb / debugpy / DAP） | ndebug |
|---|---|---|
| 看栈 | 停在断点上才能看 | **一直在看**，10 次/秒 |
| 看变量 | 停下才刷新 | **实时刷新**（局部变量 2 次/秒） |
| 影响程序 | 停下、单步、改变时序 | 只采样，程序继续跑 |
| 适合 | "这里为什么错了" | "它现在到底在干什么" |

它不是替代调试器，是补上调试器**没有的那个视角**：程序不中断的时候，时间花在哪、变量在怎么变。

---

## 快速开始

```bash
# 1. 观测示例程序（自带：嵌套调用 + sleep + 循环引用 + 密钥字段）
ndebug debugtool/samples/py/app.py -- 80

# 2. 观测你自己的程序
ndebug /path/to/app.py

# 3. 换个端口 / 采样率，不自动开浏览器
ndebug app.py --port 7400 --hz 20 --no-open

# 4. 录下来，事后还能再看一遍
ndebug app.py --record crash.ndlog -- 80

# 5. 回放（不需要原程序，也不需要 Python）
ndebug --replay crash.ndlog --speed 4

# 6. Go：程序自己开 pprof，然后 attach（Go 没有外部注入的办法）
ndebug --attach http://127.0.0.1:6060

# 7. 分享录像前先脱敏
ndebug --sanitize crash.ndlog --out share.ndlog --scrub "sk-[A-Za-z0-9]+"
```

`--` 之后的一切原样传给被观测的程序（上例里 `80` 是示例的循环次数）。

首次使用不用构建：`ndebug` 会优先用 `dist/NDebug.exe`，没有就从源码跑。

### 打包成独立 exe

```bash
npm run build:ndebug      # -> dist/NDebug.exe (约 84 MB)
```

单文件、零依赖，目标机器只要有 Python 就能观测 Python 程序。

---

## 界面怎么读

```
┌────────────────┬──────────────────────────┬──────────────────────┐
│ Watch          │ Live stacks              │ Inspector            │
│                │                          │                      │
│ order.items[0] │ <module>›main›work  62%   │ dict                 │
│   Item{2}      │ ████████████             │  order: Order        │
│                │ main›work›sleep     38%  │   id: 12             │
│ [snapshot]     │ ███████                  │   items: list[3]     │
│                │                          │    ▸ [0] Item        │
│ Exceptions     │ 3 stalls                 │    … 38 more         │
└────────────────┴──────────────────────────┴──────────────────────┘
```

**左栏 Watch** —— 你输入的表达式，实时求值。

- 输入框回车即可添加，`×` 删除。
- 求值发生在**被观测程序的调用链**上（不是最内层帧），所以程序在 `work()` 里时，`order.items` 依然能取到 `main()` 里的 `order`。
- 表达式出错不会中断任何东西，红字显示错误类型。
- `snapshot` 按钮 = 立刻抓一次当前可见变量（不依赖采样节奏）。

**中栏 Live stacks** —— 采样出来的调用栈，按占比排序。

- 每行是一次**折叠后的栈**（函数名路径），百分比 = 该栈占全部采样的比例，可以直接和火焰图对照。
- 黄色进度条 = 这段栈**连续出现了 0.5 秒以上**（卡住了，或者在等 IO）。
- 底部 `N stalls` 列出每次卡顿的时长。
- 点一行可以选中（用于对照右栏）。

**右栏 Inspector** —— 结构化地看一个值。

- 展开/折叠树节点；`[getter]`、`[depth]`、`[size]`、`[redacted]` 是**明确的截断标记**，不是"这里没有东西"。
- `↺ $` 表示循环引用回到某个路径——对象里真的有个环，不是显示错误。
- 末尾 `… 38 more` 表示被省略的数量。

**`baseline` / `diff`** —— 回答"到底什么变了"。

- `baseline` 记住当前值，之后点 `diff` 列出差异：路径、旧值 → 新值。
- 路径指向**当前**这棵树（插入一项后，后面所有下标会顺移，行里显示的是新位置；旧位置放在悬停提示里）。
- 列表里的 `unavailable` 不是"没变"，是**这一段被截断了，根本没比**——所以"没有差异"只有在没有 `unavailable` 时才成立。
- 列表最多 200 行，超出会明确写"还有 N 条未列出"。

**页脚** —— 观测台自己的开销：连接状态、目标、pid、实际采样率、丢弃计数、超限计数。**观测工具必须承认自己的成本。**

---

## 录制与回放

程序崩了之后，观测台里最有价值的东西也一起没了。`--record` 把 agent 说的话原样写到 `.ndlog`：

```bash
ndebug app.py --record crash.ndlog -- 80
```

文件就是**线上格式本身**（NDJSON，每行一个事件）+ 一行 `rec-meta` 头。这意味着：

- 回放走的是**同一个解析器**，协议一改，旧录像会立刻报错，而不是被悄悄重新解释；
- 文件可以直接 `grep`、`jq`，也可以拿去写别的分析。

```bash
ndebug --replay crash.ndlog            # 按原始节奏重放
ndebug --replay crash.ndlog --speed 4  # 四倍速
ndebug --replay crash.ndlog --speed 0  # 直接跳到最终状态
```

回放不需要原程序、不需要 Python、不需要网络——它是**读文件**。

几条刻意的限制：

| 限制 | 为什么 |
|---|---|
| 回放时 Watch 输入禁用 | 程序已经结束，表达式求不了值；显示的是录制时求出的值 |
| 默认上限 64 MiB | 长时间挂着不该悄悄占满磁盘；到上限就停并在退出时说明 |
| 写失败只是关掉录制 | 磁盘满 / 文件被占 / 没权限，都不能影响观测本身 |
| 尾部半行会被丢弃 | 崩溃时最后一行常常是半截；丢掉它并标注，而不是让整个文件读不了 |

录制文件里带着当次会话的握手 token（回放要用它复现握手）。它守护的是一个**已经关闭的**回环端口，但仍然算凭据——所以分享之前先脱敏：

```bash
ndebug --sanitize crash.ndlog --out share.ndlog --scrub "sk-[A-Za-z0-9]+"
```

它做三件事，并且**不猜**：

| 做什么 | 为什么 |
|---|---|
| 删掉 header 和 `hello` 里的 token | 它守护的端口已经关了，但读者无法知道这一点 |
| 用**当前**规则重新脱敏所有值 | 录像里的脱敏用的是录制时的规则；规则变严之后，旧录像仍然带着那个值 |
| 按你给的正则清空字符串 | 密钥可能藏在异常消息或普通字符串里，按字段名匹配看不见它 |

输出是一个新文件（永远不覆盖输入——原始文件是唯一能用更好的规则重新脱敏的东西），头部带 `sanitized` 标记，写明改了什么。

报告会说明数量：`17 events · token removed from header · token removed from 1 hello · 2 fields re-redacted · 3 values scrubbed`。**没有 `--scrub` 时字符串里的密钥会留下**——这是基于字段名的脱敏的诚实边界，报告里的 `0 values scrubbed` 就是在说这件事。

---

## 跳到 /perf

如果本机同时跑着 Nolanguage 引擎（默认 `127.0.0.1:7310`），页脚会出现 `perf ↗`：它把**这个会话的时间窗**带过去，`/perf` 顶栏会显示 `window 12:03:11 → 12:03:41 · from ndebug:app.py`，并把趋势图裁到那一段。

几条边界写在页面上，而不是让人猜：

- 引擎没在跑 → 没有链接（探测 `/health`，800ms 超时，不拖慢启动）。
- 引擎晚于 ndebug 启动 → 刷新页面即可，页面每次请求都重新渲染。
- `/perf` 的 **KPI 总计是当前 digest，不是窗口内**——趋势图被裁了，总计没有。横幅会明说。
- 趋势的时间戳是**页面自己的接收时间**。服务器播种的历史没有时间戳，这些行标 `windowed: false`，横幅会说"有 N 条趋势无法裁剪，未过滤显示"。混着裁和不裁而不说，会让同一张图有两种含义。

---

## 它是怎么做到的

```
你的程序 ──(进程内 agent)──TCP 127.0.0.1──> 引擎 ──WebSocket──> 页面
```

- **注入不改代码**：Python 解释器启动时会自动 import `sitecustomize`。ndebug 把 agent 写进临时目录，用 `PYTHONPATH` 指过去——argv、`__main__`、源码全都不动。
- **采样不是插桩**：后台线程每 100 ms 读一次主线程的栈（`sys._current_frames()`）。固定开销，不会因为程序逻辑变复杂而变慢。
- **独立通道不是 stdout**：程序自己的输出通道必须干净，所以走 loopback TCP + 一次性 token。
- **序列化不执行代码**：只读 `__dict__`/`__slots__`/内置容器，绝不调 `repr()`、property、`__getattr__`。名字里带 `token`/`secret`/`password` 的字段在**离开进程之前**就被替换成 `[redacted]`。

完整设计（协议、限额、里程碑、风险）在 [DESIGN.md](./DESIGN.md)。

---

## 安全与限额

| 项 | 值 | 为什么 |
|---|---|---|
| 监听 | 只 `127.0.0.1` | 不做远程调试 |
| 握手 | 32 位 hex 一次性 token | 同机其它进程不能随便连 |
| 采样 | 默认 10 Hz，可 `--hz` 1–100 | 观测开销可见、可控 |
| 栈深 | 12 帧 | 够用，且传输量恒定 |
| 序列化 | 深 6 / 宽 50 / 单串 512 字符 / 总节点 4000 | 一个巨大对象不该拖死程序 |
| 局部变量 | 每次最多 24 个名字，2 Hz | 变量多的函数不会刷屏 |
| 表达式 | **只执行你手动输入的** | 不自动跑任何线上来的东西 |
| 脱敏 | 可配置（见下）；默认 token/secret/password/apikey/... | 在进程内完成，不依赖 UI 遮挡 |
| 单行上限 | 256 KiB | 超了只丢这一条并计数（`oversized`），**不断开会话** |
| 未完成行 | 1 MiB 后放弃并重新对齐 | 一行永远不结束不能把内存吃光 |
| 引擎侧树预算 | 20,000 节点 | agent 限额是 4,000；这是防止别的 agent 把页面撑爆的兜底 |

**注意**：监视表达式是 `eval`，它会**真的执行代码**。写 `x.append(1)` 就会改变程序状态。工具不阻止你，但你需要知道。

### 脱敏规则可配置

默认名单是"凭据形状"的词。真实项目里总有两个方向不够用：自己的字段名不在名单里（漏了），或者 `token_count` 这种被误伤（多了）。所以有两张表，**白名单优先**：

```bash
ndebug app.py --redact sessionid,x-api-key      # 再加几个名字（子串，不区分大小写）
ndebug app.py --allow token_count               # 这些即使命中也不隐藏
ndebug app.py --config ndebug.json              # 写进文件
```

```json
{ "redact": { "names": ["sessionid"], "allow": ["token_count", "secretary"] } }
```

也可以写成一行 `{ "redact": ["sessionid"] }`。

优先级：默认 → 配置文件 → 命令行。**`names` 只能加不能减**——配置文件无法把 `password` 从名单里去掉，因为那正是这个功能最不该允许的错误。要放行就写 `allow`，它无条件优先。

规则通过握手时的 `hello-ack` 下发给 agent，所以 Python 和 JS 用的是同一份规则，而不是各自硬编码一份。

---

## 现在支持什么

| 语言 | 状态 |
|---|---|
| Python | 已支持：栈 / **实时局部变量** / 监视 / 按需快照 / 异常 |
| JavaScript | 已支持：栈（**500 ms 窗口采样**）/ 全局作用域监视 / 异常。**没有局部变量**——JS 的帧变量从外部不可达，界面会说明原因 |
| Go | 已支持（`--attach`）：**轮询 pprof 端点**拿全部 goroutine 的栈。没有 locals、没有 watch——dump 里没有值。直接 `ndebug app.go` 会打印两行改动和要跑的命令 |

不支持的语言会**直接拒绝**并说明原因，不会"挂上去但什么都不显示"。

### Go 为什么是 `--attach`

Go 没有 `sitecustomize`、没有 `--require`，也没有从进程外注入钩子的办法。它有的是 `net/http/pprof`：任何挂了 pprof handler 的程序都会用一份文本 dump 回答 `/debug/pprof/goroutine?debug=2`，里面是每个 goroutine 的完整栈。

所以 ndebug 去**轮询那个端点**。代价写在明面上：它是轮询不是进程内采样；只有栈没有值；而且 dump 里包含了产生 dump 的那个 goroutine——那个必须滤掉，否则观测台自己的 HTTP handler 永远是"最热栈"。

---

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 页脚 `waiting for agent` | agent 没连上 | 看终端：程序是否启动失败？`PYTHONPATH` 是否被程序自己覆盖了？ |
| `rejected` | token 不匹配或协议版本不符 | 通常是端口被别的进程占了；换 `--port` |
| 中栏一直空 | 程序在 agent 启动前就结束了 | 程序要活过 ~200 ms 才有样本 |
| JS 的栈很浅、没有 `step` | V8 会把小函数内联 | 看到的是被内联后的调用者，这是真实情况 |
| JS 的 watch 报 `ReferenceError` | 只认全局作用域 | 把要看的对象挂到 `globalThis` 上，或用 `globalThis.x` |
| 采样率远低于设定 | 程序在 GIL 上长时间占用 | 正常现象；降低 `--hz` 反而更稳 |
| `dropped` 在涨 | 事件产生快于消费 | 降低 `--hz` |
| `oversized` 在涨 | 某个值超过了 256 KiB 的单行上限 | 正常保护；要看那个值就单独监视它的字段，别整个对象 |
| `diff` 按钮是灰的 | 还没有为当前快照点过 `baseline` | 先点 `baseline`，改变发生后再点 `diff` |
| 回放时 `waiting for agent` | 录像里没有 `hello`（文件被截断在开头） | 换一个录像；头部行缺失的文件也能放，但没有目标信息 |
| `ndebug app.go` 直接退出 | Go 无法从外部注入 | 按输出的两行改程序，然后 `--attach` |
| `--attach` 后页脚 `agent exited` | 3 次连续拉不到 pprof | 端点挂了或程序退出；恢复后会自动重新 attach |
| Go 的 Inspector 是空的 | pprof 只有栈没有值 | 这是设计，不是 bug；用 dlv 看变量 |
| `--allow` 写了但字段还是被隐藏 | 拼写没命中（子串匹配，不区分大小写） | 用字段名里的**一段**，不要写完整路径 |
| `--sanitize` 之后文件里还有密钥 | 它只按字段名 + 你给的正则清 | 加 `--scrub`；报告里的 `0 values scrubbed` 就是在提示这个 |

---

## 开发

```bash
npm run verify:debugtool   # 协议 / 序列化 / 采样聚合 + 真实进程通道（36 条）
npm run verify:ndebug      # 会话 / 页面 / 端到端 attach + watch + diff + 录制回放（91 条）
npm run verify:diff        # 快照 diff 纯逻辑（46 条）
npm run verify:stress      # 大对象 / 大树 / 失控行 / agent 进程内开销（29 条）
npm run verify:ndebug-go   # pprof 解析 + 对真实 Go 程序 attach（44 条）
npm run verify:redact      # 脱敏规则与配置文件（36 条）
npm run verify:sanitize    # 录像脱敏导出（29 条）
npm run build:ndebug       # 打 dist/NDebug.exe
```

目录：

```
debugtool/                     门面：设计、说明、示例、探针
src/debugtool/                 应用代码
  protocol.ts                  线上格式（NDJSON v1）+ 校验
  serializer.ts                安全序列化（TS 侧规范实现）
  sampler.ts                   热栈折叠 / 卡顿检测
  session.ts                   一个被观测程序：socket + 环形缓冲 + 聚合 + 基线/diff
  diff.ts                      两棵快照树的差异（纯函数）
  recorder.ts                  录制 / 读取 / 定时回放
  redact.ts                    脱敏规则（names + allow，纯函数）
  sanitize.ts                  录像脱敏导出（去 token / 重脱敏 / 正则清洗）
  perfLink.ts                  跳 /perf 的窗口链接（纯函数）
  agents/go/pprof.ts           Go goroutine dump 解析
  agents/go/guide.ts           `ndebug app.go` 时的操作指引
  ui.ts                        自包含页面
  assets/debug-app.js          页面逻辑（Vue 3，内联）
  agents/python/               注入的 agent（sitecustomize，文本内嵌进 exe）
  agents/js/                   注入的 agent（--require，文本内嵌进 exe）
  main.ts                      库：startDebugApp()
  cli.ts                       唯一入口：ndebug 命令行
scripts/build-ndebug.mjs       单文件 exe 构建
scripts/verify-{debugtool,ndebug,ndebug-go,diff,stress,redact,sanitize}.ts
```

三条不能破的规则：

1. **观测不能拖慢或搞崩被测程序**——agent 里所有异常都吞掉，限额全有上限。
2. **不执行用户代码**——除了用户手写的表达式；序列化只读数据。
3. **省略必须可见**——截断要说原因、给数量，不能让 UI 撒谎。
