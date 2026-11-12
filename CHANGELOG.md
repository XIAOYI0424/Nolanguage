# Changelog

## 0.7.16 — 2026-11-12

### 补上文档门禁自己的静默跳过

`verify-docs` 的第一版从 `LIVE`/`DATED` 两张表里**只读存在的文件**。于是删掉一份 live 文档，针对它的路径检查、版本检查、套件数检查会全部安静地跳过——门禁报告 9/9 通过，而它守护的东西已经不在了。

这正是这门存在的理由（会静默跳过的检查比没有检查更糟），所以先把它自己堵上：

- **D0：被归类的文档必须存在。** 列表说它应该在，它就必须在。

加完立刻验证：把 `docs/ARCHITECTURE.md` 改名，D0 与 D7（读不到契约数字）同时失败；还原即 10/10。

### 验证

- `verify-docs`：**10/10** · 6 live · 9 dated
- `verify-all`：45 套件；`tsc` 0

## 0.7.15 — 2026-11-12

### 文档门禁：说法也要被检查

前几轮把代码的承诺变成了构建失败（层序、环、词汇、产品边界、预算、类型）。**关于代码的说法**一直没有门禁，代价是实打实的：

| 文档 | 它说的 | 实际 |
|---|---|---|
| `README.md` | 29 套件 / 1360 条断言 | 44 套件 / 2024 条 |
| `项目现状报告.md` | 版本 `0.7.7` | 0.7.14 |
| `README.md`、`项目现状报告.md` | 指向 `src/cli/lang.ts` | 0.7.13 已搬到 `commands/` |

`npm run verify:docs` 把文档分成两类：**live**（描述现在，六项义务）与 **dated**（带日期的快照，允许旧但必须写明日期）。每份 `.md` 必须被归类，新文档漏归类即失败。

九条检查，D6 最反直觉：**live 文档不得写断言总数**——没有任何东西能在不跑全套件的情况下核对它，而跑全套件就是 `npm run verify` 本身。写一个保不住的数字，就是在制造下一条谎言。

D7 的数字来自 `verify-architecture.ts` 写出的 `.tmp/arch-summary.json`：单一事实来源，不是复制一份逻辑再比较；文件缺失时响亮失败而不是跳过。

**门禁装上的第一分钟就抓到了自己**：新增这个套件让套件数从 44 变成 45，`README.md` 里刚写的「44 套件」立刻过期，D5 报错。

### 顺带修正

- `项目现状报告.md` 加了快照横幅：它是 `0.7.7`（2026-11-02）的记录，不是当前状态。
- `语言插件化设计.md` 里「19 套件里」改成「老套件里」——那是写作当时的数字，不该出现在 live 文档里。
- 三份评审/决策文档补上日期（取自 git 与 CHANGELOG，不是猜的）。

### 验证

- `verify-docs`：**9/9** · 6 live · 9 dated
- 注入验证：`999 files` 与一条死路径都当场 FAIL，还原即 PASS
- `verify-all`：**45 套件**；`tsc` 0

## 0.7.14 — 2026-11-11

### 类型棘轮收口：25 → 0，预算变空（从此是硬门）

0.7.13 把 `scripts/` 纳入 `tsc` 后剩 25 条，这次全部修完，`types-budget.json` 的 `budget` 变成 `{}`。空预算意味着**任何类型错误都失败**——棘轮变成了硬门。

没有一条是"注释级"的，全是类型擦除后才隐形的真错：

| 文件 | 错在哪 |
|---|---|
| `debug-completion.ts` | 调 `diagnose(code)`，签名是 `diagnose(languageId, code)`——把源码当语言 id 传了。调试脚本不在套件里，一直没人发现 |
| `verify-plugins.ts` | 用早已不存在的 `extra.runnerBytes` 算 `memoryBytes`，恒为 `undefined ?? 0` |
| `verify-baseline.ts` | `PerfEvent` 没写 `category`、`PerfMetric` 没写 `unit`；直接读 `bs.store`（私有，但同一个块里已有 `store`） |
| `verify-extensions.ts` | 返回数字的命令声明成 `string`，再跟 `6765` 比 |
| `verify-langplugins.ts` | 四处 `validate(config, 'x')`，而 `validate` 只收一个参数 |
| `smoke-exe.ts` | 手写的 health 类型漏了 `available`，于是 `!!go?.available !== false` 恒真 |
| `verify-script-host.ts` | 用 `.ts` 后缀 import，全仓只有它这样 |

### `panel/server.ts` 1566 → 970 行，账本例外删除

拆的依据是职责，不是行数：**`server.ts` 路由消息，`handlers/run.ts` 拥有进程**。

- `handleTerm` / `handleRunScript` / `handleRun` / `handleDebug` / `handleDebugCmd` → `panel/handlers/run.ts`
- `ConnState` / `stateFor` / `connState` → `panel/conn-state.ts`（两边都要，放任一边都会产生文件级环）
- 顺带把关闭回调从"读一次、删一次"改成 `takeConnection(conn)`：删除并返回，不可能漏删

### R5 补上"例外必须仍然成立"

原来预算例外只单向生效：可以豁免，但豁免**永不失效**。于是 `panel/server.ts` 降到 970 行之后，账本里那句"WebSocket switch plus HTTP routes"还在描述一个不存在的状态。现在新增一条检查——例外对应的文件/切片必须仍然超预算，否则失败。加完立刻抓到了这条过期例外。

### R6：`debugtool` 的纯净规则

新增产品规则：`debugtool` 的**线协议与分析模块**不得 import 任何 `node:` 内置模块。

| 文件 | 为什么 |
|---|---|
| `protocol.ts` / `serializer.ts` | 线格式必须能被另一进程、另一语言实现 |
| `sampler.ts` / `diff.ts` | 折叠栈、卡顿、快照 diff 都是纯算术，要能**没有被调试进程**也能测 |
| `ui.ts` | 页面是字符串；传输由服务它的人负责 |
| `perfLink.ts` | URL 归一化 |

`recorder.ts` 故意不在列表里——它写文件，那是它的职责。

规则带自检：`nodeBuiltinsOf` 先证明自己同时看得见静态 `import` 和动态 `import()`，才被允许判断真实代码。一个匹配不到东西的正则，会永远报告"纯净"。

### 验证

- `verify-arch`：**18/18** · `156 files · 444 imports` · 零环 · 零过期例外
- `verify-types`：5/5 · **0 错误** · 预算为空
- 两条新规则都做了**注入验证**：往 `protocol.ts` 加一句 `node:fs`、往 `verify-ide.ts` 加一句类型错误，都当场 FAIL，还原即 PASS

## 0.7.13 — 2026-11-11

### 还掉 0.7.12 记账的两组环：**切片图现在是 DAG**

| 曾经的环 | 怎么解的 |
|---|---|
| `kernel ↔ perf` | `PerfSpine` 原本强转 `kernel.events as EventBusImpl` 去调埋点钩子（所以它必须 import 实现类）。改成 `perf/host.ts` 声明**端口** `PerfHost`：`onCommand` / `tracer` / `logger` / `events` / `services`，由 kernel 侧适配。perf 不再知道 kernel 存在 |
| `cli ↔ desktop` | `cli/lang.ts`、`cli/dump.ts` 只依赖 `langs`，却被 `desktop/main.ts` 反向引用。拆成 `commands/` 切片（层 10）：`desktop → commands`、`cli → desktop` 单向 |

账本 `allowedCycles` 现在是**空数组**，`verify-arch` 14/14，`154 files · 435 imports`。

**端口化暴露了一个真 bug**：`Kernel` 里 `logger` 是 LogSpine 在 `perf.install` **之后**才赋值的。原来的实现是每次调用时读 `this.kernel.logger`（惰性，所以没事）；改成端口后我在 install 时就取了值，拿到 `undefined`——直到第一条慢命令被检测到才炸。改成惰性委托 `logger: { forComponent: (c) => this.logger.forComponent(c) }`，并在注释里写清原因。

### `scripts/` 终于进了 `tsc`（以预算的形式）

`tsconfig.json` 只 `include: ["src"]`，44 个验证脚本从没被类型检查过。新增 `tsconfig.scripts.json` 后掉出 **108 个存量错误**。

一次修 108 个别人的套件是"安静弄坏东西"的标准做法，所以做成**棘轮**：`scripts/types-budget.json` 记录每个文件允许携带的错误数。

- 文件变多 → 失败；新文件带错误 → 失败；修好但没下调 → `NOTE`（不挡修复）
- `npm run types:budget` 从当前状态重写（刻意手动——会自我更新的预算不是约束，是日志）

已修 83 条：`verify-pycharm` 48（一个 `socket` 可选性 → 一个 `needSocket()` 助手）、`check-panel-html` + `check-perf-html` 33（`RegExp` 当布尔用）。剩 25 条冻结在预算里。

### 又抓到两处"测试在撒谎"

- **30 条能力检查一直在无条件通过**：两个页面的 `capabilities` / `behaviour` 数组声明成 `Array<[string, RegExp]>`，但被当布尔 push 进结果——正则对象永远 truthy。改成 `.test()` 后立刻抓到一条真漂移：`time-stamps each slow span` 检查的是 app 脚本，而 `clockOf(s.at)` 在 shell 模板里。
- **`verify-plugins` 调用了一个从未定义的 `skip()`**：在没有 shell 包装器的机器上，那条分支会 `ReferenceError` 而不是跳过。

### 验证

- `verify-all`：**2019/2019 · 44 套件**；`tsc` 0；`npm test` 38/38。
- `verify-arch` 14/14（零环）；`verify-types` 4/4（25 条已冻结）。

## 0.7.12 — 2026-11-11

### 架构契约：把"分层"从文档变成构建失败

`scripts/verify-architecture.ts` + `scripts/architecture.json`，`npm run verify:arch`。五条规则，全部从真实 import 图推导，不读注释、不读文档：

| 规则 | 内容 |
|---|---|
| R1 层序 | 切片只能 import 严格更低层；27 个切片各有一个声明层号 |
| R2 无环 | 切片图和文件图都不得有成员数 > 1 的强连通分量（账本列出的除外） |
| R3 词汇 | **零 import 的 `types.ts`**（以及根下无 import 的文件）是共享词汇，任何层可引用 |
| R4 产品边界 | `debugtool` 只能 import `util`/`net`/`assets`/`vendor` |
| R5 预算 | 单文件 ≤ 1200 行、单切片 ≤ 25 文件，超出必须记账 |

**账本只能缩小**：新增违规失败、已记账的违规变多失败、已记账的违规消失也失败（逼你删过期条目）。

### 先修检查器，再谈架构

第一版分析器报"文件级循环 0 个"。那是假的：`edges` 的 key 是相对路径、value 是绝对路径，邻接查找永远落空，环检测恒返回 0。修正后真实数字是 **3 个文件环 + 8 组切片互依赖**。

所以契约的第一段是**自检**：用合成图跑 2 环、3 环、DAG、绝对路径四种情形，通过之后才允许它判断真实代码。同一个坑在词汇规则上又踩了一次——`types.ts` 的正则只认 `/`，Windows 路径是 `\`，词汇豁免整条失效，6 个切片看起来纠缠成一团。

### 解掉的耦合（实测前后）

| 动作 | 解开了什么 |
|---|---|
| `panel/WebSocketServer.ts` → `net/websocket.ts` | ndebug 不再 import 应用外壳（产品边界从违规变干净） |
| `panel/vendor/` → `src/vendor/` | vendored 代码不再属于任何业务切片 |
| `desktop/embeddedAssets.ts` → `assets/` | `panel ↔ desktop`、`extensions ↔ desktop` 两组环 |
| 4 个日志类型从 `kernel/types.ts` 移回归属（`correlation`/`log`/`util`） | `log → kernel` 4 条边 → 0 |
| `LogSpine` → `kernel/` | kernel 拥有它自己的脊柱（它本来就 `new` 它） |
| `perf/RingBuffer` → `util/` | 通用数据结构不再住在 perf |
| `Span`/`MetricSummary`/`BaselineRecord`/`RegistryRoot` → 词汇或归属切片 | `log ↔ perf`、`perf ↔ store`、`langs` 三文件环 |

**8 组互依赖 + 3 个文件环 → 2 组已记账 + 0 个文件环。**

判断"类型该放哪"的规则只有一条：**这个概念在哪里产生/持久化/定义语义**。反面教材是之前的做法——谁用得多放谁那儿，于是 `kernel/types.ts`、`perf/BaselineStore.ts`、`langs/Registry.ts` 互相 import 成环。

### 修掉两个"测试基建在撒谎"

- **`0/0` 的套件被算作通过**：一个模块被搬走导致某套件 `ERR_MODULE_NOT_FOUND` 崩在第一条断言之前，汇总仍然打印 `1978/1978 checks passed`。现在 `0/0` 记为 `EMPTY` 并计入失败，汇总行会写 `N SUITE(S) DID NOT PASS`。
- **`verify-cli-launch` 用自己的句子报告**（`2 passed, 0 failed`），harness 读不到，于是它一直以 `0/0` 隐身。改成标准格式后它真的开始被计数。
- **清理失败会带走整个套件**：`verify-webview` 里一句 `rmSync(sessionProbe)` 遇到沙箱的批量删除保护就抛异常，套件崩在最后一条断言之后，汇总变成 `0/0`。清理是 best-effort，不该是断言。

### 验证

- `verify-all`：**2015/2015 · 43 套件**；`tsc` 0；`npm test` 38/38。
- `verify-arch`：14/14（含 4 条自检）· 153 文件 · 435 条 import。
- 纯逻辑闸门：**383/383 · 13 套件**。

## 0.7.11 — 2026-11-11

### Go：`--attach` 轮询 pprof（路线改了，理由在 DESIGN）

Go 没有 `sitecustomize`、没有 `--require`，也没有从进程外注入钩子的办法。原计划的"编译期 agent"要求用户改 `go build`（`-toolec`），对 CI 构建脚本是侵入性的。

改走 pprof：任何挂了 `net/http/pprof` 的程序都会用一份文本 dump 回答 `/debug/pprof/goroutine?debug=2`，里面是每个 goroutine 的完整栈。

- `ndebug --attach http://127.0.0.1:6060` —— 地址可以是 `host:port`、pprof 索引或完整 dump URL。
- `ndebug app.go` 不再是一句"不支持"，而是**操作指引**：两行改动 + 要跑的命令 + 明确说"没有 locals、没有 watch"。
- 解析器按**真实 dump** 写（`scripts/verify-ndebug-go.ts` 的 fixture 来自一台真跑的 Go 1.27 程序）。三个只有真实数据才暴露的点：
  - 函数名带参数表（`main.work(0x7ff7...)`），不剥掉则同一个函数的两帧看起来都不一样，热栈永远合并不了；
  - 采样器自己的 goroutine 必须滤掉，而且要在**缩短函数名之前**判断（`net/http/pprof.Index` 缩短后变成 `pprof.Index`，丢了上下文）——否则"最热栈"永远是观测台自己的 HTTP handler；
  - `[chan receive, 9 minutes]` 里时长不是状态；`created by ...` 不是帧。
- 断线自愈：连续 3 次拉不到就标 detached（页面不会假装还连着），恢复后自动重新 attach。
- 页面按能力而不是按模式禁写：`caps: ['stack']` → Watch 与 snapshot 按钮禁用并给出原因。

### 脱敏规则可配置（顺带修一个死配置）

引擎一直在 `hello-ack` 里发 `redact`，**两个 agent 从来没读过**——一个看起来配好了、实际不生效的开关。现在两边都读。

- 两张表：`names`（命中即隐藏）、`allow`（命中即放行，**无条件优先**）。
- 三层来源：默认 → `--config <file>` → `--redact a,b` / `--allow a,b`。
- **`names` 只能加不能减**：配置文件无法把 `password` 从名单里去掉。要放行写 `allow`。
- 配置文件接受两种形状：`{ "redact": ["a"] }` 与 `{ "redact": { "names": [...], "allow": [...] } }`；拼错键名是错误而不是静默忽略。
- 端到端验证：真实 Python 进程里 `api_token` 因白名单**可见**、`price` 因自定义名**被隐藏**。

### 录像脱敏导出

`ndebug --sanitize crash.ndlog --out share.ndlog --scrub "sk-[A-Za-z0-9]+"`

- 删掉 header 与 `hello` 里的 token（两处都要删——只删一处等于没删）。
- 用**当前**规则重新脱敏所有值：录像里的脱敏用的是录制时的规则。
- 按 `--scrub` 正则清字符串与异常消息。**不猜**——会静默漏掉的启发式比用户配置的规则更危险，因为它制造虚假的信心。
- 不覆盖输入；输出头部带 `sanitized` 标记；报告写明数量，没有 `--scrub` 时 `0 values scrubbed` 就是在提示"字符串里的密钥还在"。
- 修一个顺序 bug：敏感名检查原先在 `prim` 分支之后，导致**基本类型的敏感字段从来没被脱敏**（只有容器会）——正好是最常见的密钥形状。

### `/perf` 时间窗互跳

- ndebug 页脚出现 `perf ↗`（仅当引擎 `/health` 可达；800ms 探测，不拖慢启动）。
- 链接带 `from`/`to`/`src`；`/perf` 顶栏显示窗口并把**趋势图**裁到那一段，可一键清除。
- 三处边界写在页面上：KPI 总计不是窗口内的；没有客户端时间戳的趋势标 `windowed: false` 并计数；窗口非法就不生成链接（`file:`/`javascript:` 一律拒绝）。
- 趋势的接收时间随值一起记，服务器播种的历史标 `0`（时间未知）而不是猜。

### 修：打包冒烟测试会写开发者的真实目录

`smoke-exe.ts` 只把 `PANEL_WORKSPACE` 和 `NOLANGUAGE_DATA` 钉进沙盒，另外三处仍在外面：

- `%TEMP%` —— 打包版每次启动都要把内嵌扩展解到 `%TEMP%\nolanguage-embedded`。沙箱拒绝写入时，exe **直接启动失败**（`EPERM`），而测试只看到"server never came up"。顺带这也是并发跑两次冒烟会互相踩的原因。
- `~/.nolanguage`（`USERPROFILE`）—— python 运行会话的目录在这里。写不进去时 run 会静默超时，表现为"python run exits 0 — exit=undefined"。

现在 `TEMP` / `TMP` / `USERPROFILE` / `HOME` 全部指进测试自己的沙盒目录。**测试不该往开发者真实的家目录里写东西**，而且这条路径原本会把沙箱策略问题伪装成产品回归——这轮就差点被它骗过去。

### 发现：`scripts/` 从来没被类型检查过

`tsconfig.json` 是 `include: ["src"]`，40 多个验证脚本一行都没进过 `tsc`。实测补上后有 **111 个存量类型错误**。这跟"vitest 静默丢测试文件"是同一类问题：**测试基建本身没有守卫**。本轮不硬修（会动到大量别人的套件），已记进 DESIGN 的下一步，并在新写的代码里避开这个盲区（例如把 `perfLink` 的字段名对齐成查询串里的 `src`，让调用方无从写错）。

### 验证

- `verify-all`：**1999/1999 · 42 套件**；`tsc` 0；`npm test` 38/38。
- 新增：`verify-ndebug-go`（44 条，含对真实 Go 程序 attach）、`verify-redact`（36 条，纯逻辑，进快速闸门）、`verify-sanitize`（29 条）；`verify-ndebug` 104 → **123 条**（含脱敏端到端、12 条互跳断言、4 条用 jsdom 验证链接真的渲染）；`check-perf-html` 53 → **59 条**。
- 纯逻辑闸门：**369/369 · 12 套件**。
- 打包 exe 实测：`--help` 有四个新区块；`ndebug app.go` 打印完整指引；录制 16 行 → `--sanitize` 后 token 两处都消失、15 个事件仍可回放。

## 0.7.10 — 2026-11-11

### ndebug：快照 diff

- **`baseline` / `diff`**：Inspector 里记住当前值，之后列出差异（路径 / 旧值 → 新值）。走 WS 命令 `baseline` / `diff`，回放模式同样可用（录下来的值仍可比）。
- `src/debugtool/diff.ts` 是纯函数，四条规则都写在文件头：路径而非位置；**截断的子树是 `unavailable` 而不是 `removed`**（没比过就不能说变了或没变，且整个结果标 `incomplete`）；序列按内容对齐（有界 LCS）而不是按下标（否则头部插入一项会把整表报成全变）；路径指向 after 树，移位项的旧位置留在 `pathBefore`。
- 输出有上限（默认 200 条），超出计数并显示"还有 N 条未列出"。

### ndebug：录制与回放

- `ndebug app.py --record crash.ndlog` → 一行 `rec-meta` 头 + agent 原始 NDJSON。**文件就是线上格式**：回放走同一个解析器，协议一改旧录像立刻失败，而不是被静默重新解释。
- `ndebug --replay crash.ndlog [--speed 4|0]`：不需要原程序、不需要 Python。`--speed 0` 直接跳到最终状态。长间隔压缩到 2 秒以内，不让一分钟的空转挡住有趣的部分。
- 录制上限 64 MiB；**写失败只是关掉录制**（磁盘满 / 占用 / 无权限都不影响观测）；崩溃时尾部半行丢弃并标注。
- 页面在回放模式下把 Watch 输入置灰并说明原因（程序已结束，表达式无法求值），头部与页脚显示录像名与进度。
- 修一个只有端到端才会暴露的问题：录像里的 `hello` 带着原会话 token，回放会话随机生成新 token → 在握手处拒绝自己的录像（样本进来了但 `target` 是 `undefined`）。回放改为沿用录像里的 token。

### 压测（`verify-stress.ts`，29 条）暴露并修掉三个真 bug

| 症状 | 根因 | 修法 |
|---|---|---|
| 10M 元素 `Float64Array` 快照 **263 ms / 151 MiB** | `Array.from(arr)` 复制整个缓冲区，只为显示 50 个数 | 按下标读前缀 → **0.03 ms / 0 MiB** |
| 目标进程每 2 秒分配 20 万个字符串 | Python agent 用 `list(raw.keys())` 拿全部键，只为前 50 个 | `len()` + 惰性迭代 `raw.items()` → **0.2 ms** |
| **一个 300 KiB 的快照直接杀死会话** | 超长行判 `fatal`，读缓冲超过 2×上限就 `reject` | 超长行计数后丢弃（`oversized`）；未完成行 1 MiB 后放弃并在下一个换行处重新对齐 |

第三条最要紧：观测工具在被观测对象出问题时才最需要，所以"一条坏数据 = 会话结束"是最不能接受的失效方式。

### 页面真挂载

所有页面断言都是字符串搜索，而**模板写坏时字符串照样匹配、页面却是空白**。新增一条 jsdom 挂载检查：Vue 在挂载时编译模板，语法错误只在这里暴露。实测 6 个按钮，`baseline` / `diff` 就位，`diff` 在无基线时禁用。再用一个假 socket 推一份真实差异进去，断言 4 行（changed / added / unavailable）、路径、双侧值、移位项的原始路径、被截断提示——`st.diff` 挂载时是 `null`，这段 `v-for` 否则永远没人渲染过。

### 引擎侧预算

- `MAX_TREE_NODES = 20_000`（agent 自己是 4_000）：预算在**遍历时**扣，耗尽即停止添加子项并把余量记进 `more`。若改成"每个剩余元素返回一个 `trunc` 叶子"，树会和被拒绝的载荷一样大（实测 50k 仍是 50k）。
- `MAX_INFLIGHT_BYTES = 1 MiB`：未完成行的读缓冲上限。

### 验证

- `verify-all`：**1862/1862**，**39 套件**；`tsc` 0；`npm test` 38/38。
- 新增套件：`verify-diff`（46 条，纯逻辑，进快速闸门）、`verify-stress`（29 条）；`verify-ndebug` 33 → **101 条**（含真实进程的 diff 往返、录制、两次回放一致性、半行录像、容量上限、不可写路径，以及用 jsdom **真挂载**页面一次）。
- 纯逻辑闸门：**327/327 · 11 套件**（原 281/281 · 10）。
- 顺带修一个测试基建缺陷：`verify-sign` 的临时目录清理在 Windows 上偶发 `ENOTEMPTY`，会让整条套件报 `0/0`（静默丢掉 28 条断言）。加退避重试后连跑三次稳定。

## 0.7.9 — 2026-11-10

### 发布流程：从"记得做"变成"做不到错"

- **`npm run build:all`**：exe + ndebug + 安装包一条命令，末尾打印产物大小与时间戳，并跑一次发布校验。
- **`scripts/check-release.mjs`**：检查三件人会忘的事——①工作区干净 ②`package.json` / `src/version.ts` / tag 三者一致 ③**产物比源码新**（二进制不能比代码旧）。`--push` 是只查干净的轻量模式。
- **`npm run hooks:install`**：装一个 **pre-push** 钩子，工作区不干净就拒绝推送。选 pre-push 而不是 pre-commit，是因为"暂存了但一直不提交"这件事，pre-commit 天然看不见（提交时当然有暂存内容）。

### CI：从"写在仓库里"变成"跑得起来"

- `esbuild` / `postject` / `jsdom` 进入 **devDependencies**：之前靠 `npm install --no-save` 临时装，注册表一抖整个作业就红，而且失败原因和改动无关。
- Node 版本对齐到 **22**（`build-exe` 的 esbuild target 就是 node22，CI 在 24 上测的是另一个运行时）。
- **干净克隆重放**（本机无远端，`workflow_dispatch` 跑不了，改用等价做法）：`git clone` → `npm ci` → `tsc` → `vitest` → `verify-all --pure`（**281/281**）→ `build:exe`（**92.6 MiB**），全过。CI 的两个作业因此有了本机证据，而不是"应该能跑"。

### ndebug：支持 JavaScript

- `src/debugtool/agents/js/nlg_agent.js`，用 `node --require` 注入（不改 argv、不改源码）。
- 采样走 **inspector 的 CPU profiler，500 ms 一个窗口**（10 ms 间隔，约 50 样本/窗口）。**这是窗口采样，不是连续时钟**——窗口之间有空隙，短于空隙的调用会漏，界面标注 `window` 而不是假装连续。
- 过滤掉两类噪声：Node 自身帧（`node:*` / `internal/*`，用 url 判断，不猜文件名）和 **agent 自己**的 `Profiler.start/stop` 调用——否则"最热栈"永远是 agent。
- 异常用 `uncaughtExceptionMonitor`：**观察但不改变行为**（普通 `uncaughtException` 监听器会让崩溃的程序活下来）。
- **没有 live locals**：JS 的帧变量不可达。Watch 只在**全局作用域**求值，界面在 Inspector 里说明原因，而不是留一个空面板。
- 示例：`debugtool/samples/js/app.js`（嵌套调用 + await 间隙 + 全局对象 + 密钥字段）。

### 修掉的一个真 bug（e2e 才暴露）

**页面先于 agent 加载时，添加的 watch 会被静默丢弃**：`session.setWatches()` 在还没有 socket 时写入无处可去，而 agent 连上后只发 `hello-ack`，两份 agent 都不读它。现在 `hello` 处理里会补发一次 `set-watches`。页面先开、程序后启是常态，这个 bug 会让"加了个监视但永远没值"。

### server.ts 按域拆（第二批）

- `handlers/perf.ts`（profile / profileLast / profileCaps / coverage / flameStart / flameStop）+ `handlers/fs.ts`（6 个 fs case）。
- **更正一个数字**：之前评估里说"900 行 WS switch"，实际是 **375 行**（443–817），那个 900 是 11-07 文档里的旧数据。`server.ts` 从 1,686 → **1,567 行**。
- 剩下的 `mcp*` / `sandbox*` **故意不搬**：它们是 3–17 行、直接转发给已经拥有逻辑的服务，搬进 handlers 只会多一个 context 对象、不会减少一个决策。理由写在 `handlers/perf.ts` 的头注释里。

### 验证

- `verify-all` 全绿（37 套件）；`tsc` 0；`npm test` 38/38。
- `verify-ndebug` 51/51（含 JS：attach → 窗口采样出 `step` → 全局 watch 拿到 `2`）。
- 干净克隆：`npm ci` + `tsc` + `vitest` + 纯逻辑 281/281 + `build:exe` 全过。

## 0.7.8 — 2026-11-10

### 仓库完整性修复（本轮最重要的一件事）

`v0.7.5` 的结构性改动与 11-07 的缺陷修复**从未进入历史**——它们一直停在暂存区：

- `v0.7.5`（客户端 8 分片、`server.ts` 按域拆出 `handlers/`、CI 入库、纯函数进 vitest、阶段 11 接 `/perf`）**没有对应的 commit，也没有 tag**；
- 11-07 的三个 P0 修复（`profileResult` 重复 case、DAP 断点在 `configurationDone` 之后下发、终端 cwd 不跟随工作区）也只 `git add` 了，没有 commit。

后果：`v0.7.7` 那棵树里**没有** `client-assets.ts`、`handlers/`、`ci.yml`，而 `CHANGELOG` 写着它们存在——tag 与文档不符，clone 出来跑的不是文档描述的东西，CI 也从未执行过。

本轮把它们一次性补提交，并**重新对齐版本号**：0.7.7 → 0.7.8 之后，tag 与树、文档三者一致。

### 修掉的三个真问题

- **vitest 会静默丢测试文件**：Vite 的转换缓存默认写在系统临时目录，写失败（沙箱/策略/占用）时 vitest 只是把该文件从运行里去掉，摘要仍显示"通过"。实测出现过"1 个文件通过、另一个文件从未运行"。缓存目录改为仓库内 `.tmp/vitest`。
- **ndebug 的 e2e 用例有竞态**：示例程序 4 秒结束，在 `verify-all` 里机器更忙时 watch 还没求值程序就退了 → 改成 20 秒目标，连跑三次稳定。
- **Windows 上临时 agent 目录删不掉**：被 kill 的解释器会短暂持有 `sitecustomize.py`，`rmSync` 抛 EBUSY，每次运行都残留一个临时目录 → 改成带退避的重试，且清理失败不影响会话。

### 清理

- 移除唯一一个"声明了但零引用"的运行时依赖 `@tauri-apps/plugin-dialog`；`dependencies` 现在真的是空的。
- 新增 `docs/README.md` 索引（7 份评估/评审/指南不再靠猜文件名找）。
- 补 `docs/评估_20261110.md`（本轮评估）。

### 验证

- `verify-all`：**1731/1731 · 37 套件**；`tsc` 0；`npm test` 38/38（沙箱内外一致）。
- 产物：`Nolanguage.exe` 92.3 MiB · `Setup.exe` 22.5 MiB · `NDebug.exe` 83.6 MiB。

## 0.7.7 — 2026-11-01

### 新应用：ndebug（实时调试观测台，独立软件）

把 debugtool 的设计做成了**独立应用**，不是 IDE 的一个页面。Nolanguage 内置调试保持基础（DAP：断点/单步/变量），ndebug 补的是另一个视角：**程序不中断的时候在做什么**。

- 入口：`ndebug app.py`（`ndebug.cmd` / `ndebug` 启动器；优先 `dist/NDebug.exe`，没有则从源码跑）。
- 产物：`npm run build:ndebug` → `dist/NDebug.exe`，Node SEA 单文件 **83.6 MiB**，零第三方依赖，保留控制台（它要打印 URL 和程序输出）。
- 三栏页面（自包含，Vue 内联）：
  - **Watch**：用户输入的表达式实时求值 + 变化历史 + 错误红字；
  - **Live stacks**：折叠后的热栈 + 占比条 + 卡顿（连续 ≥0.5s）标记 + 卡顿列表；
  - **Inspector**：结构化值树（展开/折叠、循环引用 `↺`、`[depth]/[size]/[redacted]` 明确截断、`… N more`）。
- Python agent：栈采样（默认 10 Hz）、**实时局部变量**（2 Hz）、监视表达式、按需快照、未捕获异常钩子。
- 注入方式：`sitecustomize.py` + `PYTHONPATH`——不改 argv、不改 `__main__`、不改源码；agent 源码以文本内嵌进 exe，运行时写入临时目录。
- 通道：loopback TCP + 32 位一次性 token；握手校验失败即断开。
- 安全：序列化只读 `__dict__`/`__slots__`/内置容器（不调 `repr()`/property/`__getattr__`）；名字含 token/secret/password 的字段**在进程内**脱敏；深 6 / 宽 50 / 串 512 / 节点 4000 硬上限。

**两个实测发现并修掉的问题**

- 监视表达式原先只在**最内层帧**求值：程序停在 `work()` 里时，`order.items` 必然 `NameError`（`order` 在 `main()` 的帧里）。改成沿调用链合并命名空间（内层优先），这才是用户对"变量"的直觉。
- 启动瞬间采到的是 **agent 自己**（`sitecustomize > boot > start > wait`），会霸占"最热栈"。现在这类样本直接丢弃——"还没有数据"是诚实的，"agent 是最热路径"不是。

**其它**

- `WebSocketServer` 增加 `broadcast()`（逐连接隔离，一个半关闭的客户端不会打断整轮广播）。
- 新增套件 `Debug · observatory app (ndebug)` 33 条（会话 / 页面 / 端到端 attach + watch）；`verify-all` 增至 37 套件。

### 验证

- `verify-ndebug` **33/33**：真实 Python 进程 attach → 热栈 → 实时局部变量 → 页面加 `len(order.items)` 拿到 `3`。
- `verify-debugtool` 36/36；`verify-all` **1708/1708 · 37 套件**全绿；`tsc` 0 错误。

## 0.7.6 — 2026-11-01

### 实时调试观测台：设计与 M0

- `debugtool/DESIGN.md`：补 DAP / profiler 之间的空档——程序跑着的时候在做什么。采样而非插桩（10 Hz，<1% 开销）；loopback TCP 而非 stdout；Python 用 `sitecustomize` + `PYTHONPATH` 注入；JS 计划 `--require` + inspector 窗口；Go 编译期（在此之前明确降级）。
- `src/debugtool/`：`protocol.ts`（NDJSON v1，版本不符致命 / 未知类型丢弃不致命 / 256 KiB 上限）、`serializer.ts`（只读数据描述符、循环检测、序列化前脱敏、节点预算硬截断）、`sampler.ts`（热栈折叠 + 卡顿窗口 + 实测采样率）。
- `debugtool/probes/` + `samples/py/app.py`：真实 Python 进程 10 Hz 上报主线程栈，程序 stdout 不受影响。
- `npm run verify:debugtool` 36/36。

## 0.7.5 — 2026-10-27

### 结构：客户端脚本拆分（P0）

- `pycharm-client.ts` 从 **4,196 行单模板字符串**拆成 8 个纯 `.js` 分片（`src/panel/ui/client/00-core … 70-shell`），用 `?raw` 文本导入后由 `client-assets.ts` 按序拼接。**没有模板字面量，就没有"注释里一个反引号截断整页"这个失效模式**。
- 拆分**逐字节等价**：改前/改后各生成一次 `pyCharmClientScript()` 输出，`cmp` 一致（200,278 bytes / 4,168 行）。插值改成 `${name}` 令牌 + 运行期替换（`split/join`，避免 JSON 里的 `$&`）。
- 守卫升级为 5 条：分片数 6–8、磁盘分片与装配表一一对应、分片内无反引号、只允许 7 个已知令牌、装配后无残留令牌。

### 结构：server.ts 按域拆分

- 新增 `src/panel/handlers/`：`languages`（校验/诊断/补全/hover/markdown）、`migration`（解释器 + `.idea` + pin 持久化）、`attribution`（阶段 11）、`plugins`（插件页 payload + 扫描根）。`server.ts` **1,810 → 1,424 行**，`main()` 未动（避免动闭包）。

### CI 入库

- `.github/workflows/ci.yml` 之前被 `.gitignore` 排除，现在入库并拆成两个作业：
  - `pure`（约 2 分钟）：`tsc` + `vitest` + `verify-all --pure`（10 个不需要服务器/工具链/浏览器/exe 的套件）；
  - `integration`（依赖 `pure`）：构建 exe → 全量套件 → 构建安装包 → 静默安装 + `/health` 冒烟 → 卸载校验 → 可选 Tauri 打包。
- `verify-all` 新增 `--pure` / `--skip-exe` / `--only <substr>` 过滤。

### 纯函数进 vitest

- `tests/pure.test.ts`：38 个用例覆盖归因（t 分布 / welch / cohen / cusum / verdict / 二分）、解释器选择与发现、XML、启动握手、`.idea` 导入。`npm test` 从 9 → 38 用例，秒级反馈。

### 阶段 11 接进 /perf

- `/perf` 选中指标后出现 `explain change`：向引擎发 `attribute`，在趋势图下方渲染判定卡片（verdict / 置信度 / 相对变化 / p / Cohen's d / 样本数 / 变点位置），可 dismiss。6 条断言守住"页面真的会发这个消息、真的显示证据而不只是一句话"。

### WebView2 / Tauri：正式搁置

- `webView2Version()` 增加 **per-user 安装路径**（`%LOCALAPPDATA%\Microsoft\EdgeWebView\Application`），否则按用户安装的新运行时会看不见。
- 升级运行时失败且原因明确：本机运行时 **143.0.3650.139 为机器级安装**，当前会话非管理员；Evergreen bootstrapper 与 204.9 MiB 离线独立安装包都返回 **`0x80040828`（已安装、无权限替换）**。
- 用 `src-tauri/examples/probe.rs`（最小 wry 探针：一个窗口 + 内联 `data:` 页面，无 IPC / 无配置 / 无 hardening）做对照实验：**WebView2 能拉起 13 个宿主进程，但页面永远加载不完**；`--disable-gpu`、`--no-sandbox`、`--disable-dev-shm-usage` 均无效。结论：**故障在环境（运行时 143），不在我们的壳**。
- 决定：**Tauri 桌面壳正式搁置**（代码保留、不发布、不投入），桌面形态继续用 Edge `--app`。解除条件见 `docs/Tauri搁置说明.md`：管理员权限升级 Evergreen 运行时，或随包携带 fixed-version 运行时（+150MB）。

### 验证

- `verify-all`：**1616/1616，35 套件，0 失败**；`tsc` 0 错误；`npm test` 38/38。
- `verify-pycharm` 246/246（含 5 条拆分守卫）；`check-perf-html` 53/53（含 6 条归因断言）；`verify-webview` 51/51。
- 纯逻辑闸门（CI 第一作业）：10 套件全绿，约 2 分钟。

## 0.7.4 — 2026-10-27

### 体检修复

- **`.idea` 导入丢参数**：导入存的是 `params`/`workdir`，而运行/调试读的是 `args`/`cwd` → 参数与工作目录被静默丢弃。改存 `args`/`cwd`，并加引号感知的 `splitArgs`（`--data "C:/My Data"` 不再被拆碎）。
- **相对 cwd 指向不存在目录**：调试 `cwd` 直接透传给 DAP，`.idea` 的 `$PROJECT_DIR$/src` 会失败。服务端改为按 `workspace.root` 解析。
- **单测文件未入库**：`tests/phase1.test.ts` 在 `.gitignore` 里，新克隆跑 `npm test` 没有测试。移出忽略并入库；`docs/`、`.workbuddy-ai/` 加入忽略。
- 删除死代码 `ideaImport.isDirectory`、`xml.byAttr`；给 `clearEmbeddedSignature` 补真实文件测试（`build-exe` 内联版本的对偶实现）。
- `verify-pycharm` 增加"模板内不得有反引号"守卫（同类事故已两次）。
- 版本 0.7.3 → 0.7.4；全量 1606/1606。

## 0.7.3 — 2026-10-27

### 代码签名

- 新增 `installer/sign.ps1`：Authenticode 签名，支持 `-Pfx`（真实证书）、`-Thumbprint`（证书存储）、`-SelfSigned`（本地开发证书），以及只读的 `-Verify`。没有证书时**明确拒绝并 exit 2**，不会假装签过。
- 签名走 `Set-AuthenticodeSignature`（Windows 自带 CryptoAPI），不依赖 Windows SDK / signtool；时间戳服务器不可达时自动降级为无时间戳签名并说明。
- 新增 `src/cli/signature.ts`：PE 证书表（数据目录 4）解析，判断"是否有内嵌签名"；`verifySignature()` 调 CryptoAPI 判定有效性，区分**内嵌签名**与**目录签名（.cat）**——系统 exe 大多没有内嵌签名但仍然有效。
- **修复 SEA 无法签名**：`node.exe` 的证书表被 SEA 继承，指针落在文件中段，Authenticode 直接拒绝（`%1 不是有效的 Win32 应用程序`）。构建时清零该目录项，exe 恢复"诚实未签名"且可签名。
- `nlg doctor` 增加 `signature` 行（`Valid` / `NotSigned` / `UnknownError` + 签名者），未签名时给出提示。
- `npm run sign` / `sign:verify` / `build:sign`。

### P1 迁移三门槛

- **解释器识别**（`src/langs/interpreters.ts`）：扫描项目 `.venv`/`venv`/`env`（`pyvenv.cfg` 校验）、conda `environments.txt`、pyenv/nvm/volta、PATH；按语言用**数据表**描述（`INTERPRETER_SPECS`），逻辑无语言分支。`pickInterpreter()` 优先 pin → 项目 venv → SDK 名称匹配。
- 运行时切换：`WorkspaceService.setToolchain()` **重建 slot**（runner 与 LSP 都按二进制装配，半更新会出现"报新的、跑旧的"）；选择持久化到 `toolchains.json`，环境变量 `PYTHON_BIN` 等仍优先。
- **`.idea` 导入**（`src/langs/ideaImport.ts` + `src/util/xml.ts`）：读取 `.idea/runConfigurations/*.xml`、`.run/*.xml`、`misc.xml`（project SDK）、`modules.xml`；展开 `$PROJECT_DIR$` 等宏，跳过 `default="true"` 模板，重名与无脚本项记为 warning。新增零依赖 XML 解析器（实体/CDATA/注释/引号内 `>` 均处理）。
- **Keymap**：`Ctrl+F` 查找条（计数、Enter/Shift+Enter 跳转、大小写规则同 PyCharm）、`Ctrl+H` 替换（单个/全部）、`Ctrl+D` 复制行、`Ctrl+Y` 删除行、`Ctrl+/` 注释、`Ctrl+G` 跳行、`Ctrl+Shift+Z` 重做；Code 菜单同步列出。
- 菜单：Tools → Project Interpreter…；File → Import PyCharm Run Configurations…；Tools → Explain Performance Change…

### 阶段 11 · 归因引擎

- 新增 `src/perf/Attribution.ts`：`cusumChangePoint`（双侧 CUSUM 变点）、`welchT`（不等方差 t 检验 + 不完全 Beta 求 p）、`cohensD`（效应量分级）、`bisectSuspects`（good/bad 二分，遇到 `unknown` 降级为线性扫描而不是猜）。
- `attribute()` 合成判定：只有 **p < 0.05 且 |d| ≥ 0.2** 才叫变化，confidence 上限 0.99（样本自相关会让 p 偏乐观）。
- WS `attribute` 命令：从热路径 perf ring 取样，按中点或 `splitAt` 切分，返回 verdict/置信度/效应量/变点。

### 桌面 / 诊断

- `webView2Version()` 优先读 **Evergreen Runtime**（`EdgeWebView\Application`），Edge 的 `EdgeCore` 只作兜底。此前它报告 WebView2 151，而嵌入式应用实际加载的运行时是 **143**——这正是"窗口空白"与"能跑"的差别。
- Tauri：wry 0.57.0 → **0.57.1**、tauri 2.12.4 → 2.12.5；移除自定义 `additionalBrowserArgs`；`harden_webview` 从 `setup` 移到页面加载完成后（`with_webview` 在 setup 阶段与浏览器进程竞争）。
- **Tauri 仍不可用**：日志 `page-load never finished within 20s`，无 `msedgewebview2` 宿主进程。运行时 143 与 wry 0.57.1 不匹配是最可能的原因，需更新 WebView2 Evergreen Runtime 后复测。0.7.3 仍**不发布** Tauri 安装包。

### 验证

- 新增 3 个套件：`Migration · interpreter + .idea import`（43）、`Stage 11 · attribution engine`（38）、`Release · code signing`（29，含真实签名往返：复制 dist → 自签名 → Windows 验签）。
- `verify-pycharm` 237/237（新增 keymap 17 条 + 迁移 6 条，jsdom 实测查找替换/行编辑/解释器弹窗/导入持久化）。
- `verify-webview` 51/51（新增运行时优先级断言）。
- `verify-all`：**1598/1598，35 套件，0 失败**；`tsc` 0 错误。

## 0.7.2 — 2026-10-27

### 启动版本握手

- 新增 `src/desktop/handshake.ts`：启动时不再以「`/health` 有响应」判定自己多余，而是比较**构建身份**（`appVersion` + `exeSize`）：
  - 同构建 + 有窗口 → `reuse`（不重复开窗）；
  - 同构建 + 无窗口 → `takeover-orphan`（抢回端口重启）；
  - 不同构建 → `takeover-update`（替换旧实例），不再静默退出让用户继续看旧 UI。
- 旧于 0.7.1 的服务器不返回 `build`，按 `unknown-build` 处理为需要替换，而不是「大概是同一个」。
- 新增 `src/version.ts`：`APP_VERSION` 单一真相源，`server.ts` 不再硬编码 `0.7.x-workspace`。

### 自动更新提示

- 替换旧构建时窗口地址带 `?updated=<旧版本>`；页面首帧 toast「Updated from 0.7.1-workspace - new build loaded」，随后 `history.replaceState` 去掉参数，刷新不再重复。
- 普通启动仍是干净 `/`，不带参数。

### 验证

- 新增 `verify-handshake` 33 条（判定表 + 接线断言 + 版本一致性），接入全量（第 32 套件）。
- `verify-pycharm` 新增 3 条：`?updated=` 会提示、参数被清除、普通启动不提示（jsdom 实测 toast 文本）。
- `verify-all`：**1465/1465，32 套件，0 失败**；`tsc` 0 错误。
- 真机：0.7.1 在跑时启动 0.7.2 → 日志 `handshake takeover-update version-mismatch 0.7.1-workspace → 0.7.2-workspace`，窗口 URL 带 `?updated=0.7.1-workspace`；同构建再次启动 → `handshake reuse same-build`，窗口数保持 1。

## 0.7.1 — 2026-10-22

### 发布闭环

- `/health` 新增 `build`：`appVersion / pid / exePath / exeSize / startedAt`。
- 桌面启动写 `install-receipt.json`；仅 `NOLANGUAGE_DESKTOP=1` 的打包入口写，源码/测试服务器不再用 `node.exe` 覆盖。
- 新增 `nlg doctor [--json]`：版本、exe、sha256、receipt、session、health、端口、Edge/WebView2、Git/Python/Go，以及五态诊断（`ok / not-running / orphan-server / port-conflict / window-missing`）。
- 新增 `verify-doctor` 10 条，接入全量（第 31 套件）。

### 测试稳健性

- `verify-ide` 的 `user-code` 断言改为最多 5s 轮询历史帧，消除全量并发下的漏帧。

### 验证

- `verify-all`：**1429/1429，31 套件，0 失败**。
- `tsc --noEmit`：0 错误；`npm test`：9/9。

## 0.7.0 — 2026-10-22

### 桌面与稳定性

- Edge `--app` 启动不再设置 `windowsHide`：Node 的 `windowsHide` 会给子进程 `STARTF_USESHOWWINDOW` + `SW_HIDE`，Chromium 把首窗也按隐藏启动，导致“进程在跑但窗口不显示”。新增 `findVisibleWindows`，只有真实窗口句柄才算 UI。
- 二次启动孤儿服务接管 + 8s 关停硬超时：`server.close()` 卡住时不再把 7310 留给下一次启动。
- Git 探针加 `windowsHide: true`，消除 `Git/git.exe` 控制台弹窗。
- Tauri 壳加入 `tauri-shell.log` 与页面加载看门狗（experimental，不随 0.7 发布）。

### IDE

- MCP 客户端：配置加载、stdio 生命周期、`tools/list`、`tools/call`、侧栏面板。
- i18n：`zh-CN` 本地化插件（`builtin/zh-cn@1.0.0`，`type: localization`），未覆盖项回落英文。
- 断点 gutter、Coverage（Python `trace`）、Kernel Flame（V8 inspector）、Git VCS 面板（status / commit）。
- `stop` / `debug` / `debugCmd` 命令与 PyCharm 外壳接线。

### 语言与插件

- 工具链 `versionFiles`（plain / json / toml / regex）+ `knownPaths` 单段 glob，按项目声明排序候选。
- debug `install` 提示：debugpy / delve 缺失时给出具体安装命令。

### 验证

- `verify-all`：**1419/1419，30 套件，0 失败**。
- `npm test`：9/9；`tsc --noEmit`：0 错误。
- 新增 `verify-mcp` 12 条并接入全量验证。

### 已知问题

- Tauri 原生窗口在 wry 0.57 + WebView2 143 上启动崩（`msedge.dll`，`SubCode=0x80000003`），且无更新版本可升；0.7 不发布 Tauri 安装包，桌面使用 Edge `--app`。
- 阶段 11 归因引擎、插件市场远程安装 + `trust.signature` 尚未开始。
