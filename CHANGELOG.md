# Changelog

## 0.7.24 — 2026-11-15

### 启动：不再等一个语言服务，版本探测改为缓存

启动耗时测出来之后（`npm run verify:startup` 之前是一组一次性探针），最大的一块不是内核，是**等 python 的服务**：`builtin/python@1.0.0` 是唯一 `lsp.eager: true` 的语言，`workspace.init()` 里同步等它握手。把它关掉，`init()` 从 **439–518 ms 掉到 138–150 ms**。

代价是首次 Python 击键要自己付这笔钱（pyright 约 1.0–2.3 s），所以同时做了**两段式启动**：manifest 声明了 `bundledFallback` 且 `eager` 为假时，先起 stub（`nolanguage-py`，约 400 ms），由它回答第一次补全；真服务 300 ms 后开始握手，就绪后接管并停掉 stub。实测首次击键 **415–417 ms**，随后 pyright 接管（8 项成员）。

版本探测（`--version`，每语言 58–149 ms，九个 manifest 串行 607 ms）改为**按签名缓存**（`src/langs/versionCache.ts`）：签名 = 二进制路径 + size + mtime + 参数。命中时 `init()` **189 → 19 ms**；二进制换了、参数换了自动重探；**失败不缓存**（用户修好 PATH 之后不该被"记得是坏的"挡住）。

`perf-baseline.json` 记录每个语言的三个阈值（握手 / 首次有内容 / 结果稳定），门禁 `verify:startup` **只看 `stable`**：握手快不代表能答，rust-analyzer 1.0 s 回 16 项、4.7 s 才到 138 项，用握手当门禁等于用最不可控的那个数当门禁。

**一次击键 9.5 ms，95 倍于裸 CodeMirror——修好后 1.2 ms。** 用 CDP 在真实页面上对比
「app 的编辑器」与「同版本裸 CM5 + 同 mode」：500 行文本、30 次插入，app 286 ms、裸 3 ms，
而且**与文件大小无关**（20k 行也是 263 ms）——说明不是编辑器、也不是渲染，是我们自己的
输入回调。原因：`renderEditor()` 在每次 change 里无条件 `cm.setOption('mode', …)`，CM5 会
因此重建模式并重跑高亮。改成只在语言真的变了才设置（`CM_MODE_LANG`），286 → 38 ms。
顺带把 `updateCaret()` 在 CM 激活时的 `value.slice(0,pos).split('\n')` 换成 `cm.getCursor()`，
不再每次击键扫全文。

`verify:ui-live` 增加一条门禁：500 行、30 次插入 **< 150 ms**（现在 35 ms · 1.2 ms/字符；
修复前 286 ms）。这是这条套件第一次能抓到「每次击键都做重活」这类回归。

**`File → Open Folder` 在桌面版里一直是死的——现在能弹系统对话框了。** 菜单项走的是
`__TAURI_INTERNALS__`（Tauri 的 dialog 插件），而产品跑的是 Edge `--app`，那个对象根本不存在，
于是 `nativeOpen()` 返回 `null`，界面只弹一句「原生选择器只在桌面版可用」——**在桌面版里**。
Tauri 搁置之后，换项目根目录的唯一办法是 `Ctrl+Alt+O` 里手打路径。

现在没有 Tauri 时请求发给引擎，由 `src/util/nativePicker.ts` 调系统对话框：
`FolderBrowserDialog` / `OpenFileDialog` / `SaveFileDialog`，脚本按 `-EncodedCommand`
（base64 UTF-16LE）传——标题里有引号、过滤器里有花括号，用 `-Command` 拼字符串迟早出错。
取消（没有输出）与「对话框打不开」（有 message）分开处理，后者会在界面上说出来。

`verify-panel` 14 → **22**：生成脚本的形状（单引号加倍、WinForms 过滤器串、取消解析），以及
**用真实解析器跑一遍生成文本**——把 `ShowDialog()` 换成属性输出，不弹窗但走真解析器。
一个引号 bug 的结果是「对话框永远不出现」，正是这次要修的东西。

**安装冒烟在一台装了真实副本的机器上是破坏性的——修了三个缺陷。** 这次按要求跑
`npm run ci:install-smoke`，它通过了，但它对宿主做了三件不该做的事：

1. **探错了端口。** 它装到 `%TEMP%\nl-smoke` 却去探 `7310`——那是用户正在用的编辑器的端口，
   所以任何遗留监听都会让它**假通过**。改成专用 `7391`，并断言 `/health` 的
   `build.exePath` 就是它刚装的那份（`port 7391 is answered by '…', not by the smoke install '…'`）。
2. **杀了宿主。** `Get-Process Nolanguage | Stop-Process` 和安装器里的
   `taskkill /IM Nolanguage.exe /F /T` 都是"机器上所有 Nolanguage"。实测：跑一次冒烟，
   你开着的编辑器就没了。现在安装器/卸载器改用 `stop-instance.ps1`——按**镜像路径**过滤，
   只停 `$INSTDIR` 下那一个，并且等文件真的可写而不是 `Sleep 1500`；冒烟只停它自己的 pid。
3. **改坏了开始菜单。** 还原用的是"删掉整个文件夹再拷回去"，遇到被 Explorer 短暂占用的 `.lnk`
   就 `-ErrorAction SilentlyContinue` 跳过删除，拷贝撞上残留文件 → 三个快捷方式全指向
   `%TEMP%\nl-smoke`（已删除的目录），你的真快捷方式没了。改成**逐文件覆盖**（失败先重命名再写，
   因为 Windows 允许改名但不允许覆盖），并在结束时删掉安装器多出来的项。

另外两处：冒烟现在用**自己的 home**（`$dir\home-smoke`），不再写你的插件注册表和运行配置；
跳过卸载时**补偿 PATH**（安装器会把自己的目录加进用户 PATH，卸载器才移除，跳过卸载就留了一个
指向已删除目录的条目——实测确实留下了，已清理并加进 `finally`）。

实测（宿主 pid 全程不变）：`install smoke: ok` · 冒烟实例 pid 独立 · 宿主存活 ·
快捷方式仍指向 `D://Nolanguage` · PATH 无残留 · 卸载项指向 `D://Nolanguage`。
另单独验了 CI 分支（无真实安装时才跑卸载）：临时安装 → 卸载 → 目录清空、PATH token 移除、
宿主未受影响。

**「声明了但没接」现在有门禁了：R7 与 R8。** `RunRequest.args` 那次不是孤例，是一种形状——
字段声明了、类型对了、面板转发了、没人读，编译干净、测试全绿、功能安静地不生效。所以
`verify:arch` 增加两条规则：**R7** 跨运行时边界的接口，每个字段至少要有一个运行时读过；
**R8** `RuntimeExtension.supportsArgs` 必须与代码一致（声明 `true` 的必须读 `opts.args`，
声明 `false` 的必须不读）。两条都有自检（扫描器先在合成样本上证明看得见字段、且注释不算读过），
并做了**故意注入验证**：把两处 `opts.args` 改成 `opts.arguments` 后

```
FAIL  R7 wiring: every RunRequest field is read by a runtime  — never read: args
FAIL  R8 args: the supportsArgs flag matches the code  — repl-session.ts: declares true but never reads opts.args · template.ts: …
```

还原后 22/22。**门禁抓得住那个 bug，才算数。**

**每个运行时现在声明自己能不能收参数。** `supportsArgs`：`template` / `repl-session` 为真，
`directory-session` / `inline-vm` / `script-host` 为假（固定步骤列表 / 进程内求值 / 入口脚本自己解析）。
`languageList` 把它带给页面，运行配置对话框对 javascript 这类语言**停用**「程序参数」并写明
「inline-vm 不把参数交给程序，所以这一栏停用——存了也不会生效」；引擎再兜一层，收到不支持的参数
记 warn 并丢弃。实测（CDP 驱动真实页面）：python `args=enabled`、javascript `args=disabled`。

**`Ctrl+Alt+R` 从来没到过编辑器——修了。** 全局守卫拦浏览器刷新写的是
`e.ctrlKey && k === 'r'`，**没排除 Alt**，而它在捕获阶段 `stopPropagation()`，于是
`Ctrl+Alt+R` 被当成刷新吞掉。菜单项能开，所以手工点看不出来；只有真按一次键才发现。
加 `!e.altKey` 后两条路径都通。

**`verify` 的摘要现在自己解释总数为什么变。** 之前只打 `2390/2390 across 53 suites`，
少掉的检查去哪了没人知道。现在末尾按原因聚合：

```
  15 check(s) not run across 5 suite(s) — they are in no denominator below:
      4  gopls not installed
      2  no real server installed in this home
      …
```

因为缺工具链**不会让检查失败，它会让检查不进分母**（一个每服务器 3 条断言的探针，服务器不在时
只剩 1 条 SKIP），所以「2411 → 2390」这种数字必须由日志回答，不能靠回忆。

`npm test` 190 → **192**（`supportsArgs` 的五种运行时 + 未知 mode 一律 false）。

**运行配置（Ctrl+Alt+R / File 菜单）。** 名称、程序参数、工作目录、环境变量四个字段，存
`<home>/run-configs.json`（跟着用户走，不跟着项目走）。其余（解释器、超时）仍来自语言 manifest。

接通过程中发现这条链**三处断点**，全部修了：`RunRequest.args` 声明了但 `WorkspaceService.run()`
不转发；`steps.ts` 不把参数拼进 argv；**Python 的 `bootstrap.py` 把 `sys.argv` 重置成
`[source]`**——最后一处最隐蔽，前两处修完仍是空。实测：`args: ['--x','a b']` →
`sys.argv[1:] == ['--x','a b']`，`env` 也可见。

参数只加在最后一个可运行步骤上（`go build` 不会被塞用户参数）；`splitArgs()` 只处理引号，
不做 glob/变量/操作符展开。

`npm test` 185 → **190**（store 增删改、名字/语言校验、引号切分、env 解析、坏文件不崩）。

**添加依赖（Ctrl+Alt+D / File 菜单）。** 按项目标记选命令（`cargo add` / `go get` / `uv add` /
`npm install`），在项目目录里跑工具链自己的命令，原样展示输出。不解析 lock 文件、不改版本号——
那是工具链的事；这里只解决「用哪个命令、在哪个目录」这两个最容易做错的决定。

`<spec>` 在任何进程启动前按白名单校验，空白和 shell 元字符一律拒绝（命令不走 shell，但
「看起来像第二个参数」的输入不该有机会）。失败不写盘：工具链失败时项目原样不动。

`npm test` 178 → **185**（四种生态的命令规划、probe、非法 spec、无项目目录）；CDP 冒烟：
Ctrl+Alt+D 从 `Cargo.toml` 识别出 `cargo add`，输入 `serde && rm -rf /` 被拒绝。

**导入现有项目（Ctrl+Alt+O / File 菜单）。** 文件已经存在，所以这不是向导：扫当前目录 + 一层
子目录的项目标记（`Cargo.toml` / `package.json` / `pyproject.toml` / `setup.py` / `go.mod` /
`pom.xml` / `CMakeLists.txt`），跳过 `node_modules`/`target`/`dist`/`build`/`.venv`，显示名优先
从标记文件里读。打开复用现有的 `openFolder`（`fs.setRoot`）——没有新的写入路径，只有新的发现路径。

**语言没装也能打开**：它只是一个目录。这和向导里「不可用模板置灰但可见」是同一条原则。

`npm test` 175 → **178**（探测：根+一层、跳过构建目录、名字回退、空目录）；CDP 冒烟：
Ctrl+Alt+O → 2 个候选（`svc` / `web-app`）→ 打开 → 资源管理器根从 `ws` 变成 `web`。

**文件模板：同一套机制，`kind: "file"`。** 在已有项目里新建一个文件（pytest 测试、Rust 模块、
JS 模块、Go 测试），路径自带子目录（`tests/test_{{name}}.py`），所以表单只问文件名，生成后
直接打开它。左侧多了「类型」筛选（全部 / 新项目 / 新文件）——**这不是新概念，只是 `kind` 的过滤**。

顺带修掉一个会毁掉生成物的错误：向导的目标根原来取 `workspace.root`，那是**语言缓冲区的临时
目录**（`nolanguage-ide-<pid>`），项目生成在那儿会随会话消失。改成 `projectRoot()`
（`projectDir ?? rootDir ?? cwd`）。冒烟测试正是靠「生成后工作区是空的」暴露了它。

**项目向导：模板写在 manifest 里，UI 不认识任何语言。** 三栏（语言/来源筛选 → 模板卡片 →
schema 表单），`Ctrl+Alt+N` 或 File 菜单打开。`scaffold.templates` 声明参数
（`text | select | boolean | multiselect`）、`pattern` 校验、`suggestedDir`、以及 `when` 条件文件；
装载时校验占位符与选项，写模板的人在安装插件时就知道写错了。

服务端强制目录规则（绝对路径、非根、非空目录需显式允许、路径不许 `..` 或盘符、写前再算
`relative()` 防符号链接逃逸），参数只保留 schema 声明过的键。不可用的模板**置灰不隐藏**，
并写明原因——和 LSP 里 SKIP 必须归因是同一条原则。

`scaffold` 是新的第 3 层（只依赖 node 内置），`npm test` 169 → **174**；CDP 冒烟验证了
「打开 → 选卡片 → 创建 → 文件出现在工作区」。外部 provider（Initializr / cookiecutter）
的形状已定，尚未接入。

**长期使用数据落盘：`logs/usage.jsonl`。** 调 TTL、判断要不要换编辑器，都需要真实的一周，
而 app.log 会滚动、混着调试输出。新文件是 append-only JSONL、一行一事件、带 schema 版本，
按 8 MiB 轮转保留 4 份；只记语言 id / 时长 / 计数 / 尺寸，**不记源码、路径、用户名**。
`npm run usage` 出四块：请求耗时（按语言×方法，n/median/p90/max/失败数）、服务器启动成本与
闲置分布（含 TTL 判定）、打开的文档行数（对照 CM6 的 100k 触发线）、以及 `--json` 给脚本用。

**顺手修正一个我自己造成的错误结论：** `RawWsClient.waitForWhere` 每 50 ms 轮询一次，所以
「补全 WS 往返 54–63 ms」量到的是探针的轮询粒度，不是产品——改成事件驱动后是 **3 ms**
（引擎侧 1–2 ms）。之前用它论证「管道不是瓶颈」：结论对，理由错。

**java 的空闲 TTL 从 5 分钟改到 2 小时，并补上决定它该多长的埋点。** 只有 java 走池化管理器，
而 jdtls 重启要 6.3–7.0 s——5 分钟 TTL 等于每次离开一会儿就重新交税。TTL 挂在 manifest 的
`lsp.idleTtlMs` 上而不是全局常量：clangd 重启 86 ms，占两小时内存不值。

但 2 小时是**保守起始值**，不是结论。管理器现在写三条结构化记录：`lsp.server.reused`
（带 `idleMs`）、`lsp.server.started`（带 `startMs`）、`lsp.server.reaped`；`npm run lsp:ttl`
把它们变成每种语言的 median/p90/max 闲置时长 + 当前 TTL + 一句判定
（`ttl-is-generous` / `ttl-is-tight` / `no-data`）。判定逻辑是 `src/lsp/ttlStats.ts` 的纯函数，
5 条单测——**没有样本时它说 `no-data`，不猜**。

**CM5 → CM6 的观察项上线：** `verify:ui-live` 每次记录 100k 行的三个数，不参与判定。
第一次实测：**setValue 30 ms · 首次击键 5 ms · 30 次击键 171 ms（5.7 ms/字符）**。触发线是
setValue > 100 ms 或击键 > 5 ms——**击键这一项已经压在线上**（500 行时 1.0 ms）。

`npm test` 157→**162**。

**`verify:ui-live` 的 5 条红是测试坏，不是产品坏。** 手动驱动真实 app（CDP）复现：
套件把光标放在第 13 行的 `"hello from fib(10) = "`——**字符串字面量里**的 `fib`，因为
`indexOf('fib')` 先命中引号内那个。goto 一个字符串自然什么也不返回。改成 `lastIndexOf('fib(')`
之后：Ctrl+B 从 Ln 13 跳到 **Ln 5（`def fib`）**、Alt+F7 **4 行**、焦点回到编辑器。
剩下两条 quick fix 改成如实 SKIP——pyright 1.1.414 对 `undefined_thing()` **带不带诊断
上下文都返回 0 个 code action**（直接对服务器验证过），这是它的能力边界。

**顺带修掉一个跨文件跳转的隐患：** pyright 返回 `file:///c%3A/tmp/a.py`（冒号百分号编码、
盘符小写），客户端把它当路径用就会打开一个不存在的文件、而且**不报错**。`normalizeLocations`
现在统一成 `file:///c:/tmp/a.py`，`navOpen` 再兜一层 `decodeURIComponent`。协议层用假服务器
把这条钉住：`nav: file URIs are decoded before they reach the UI`。

**协议层进 CI（不依赖真实服务）：** 假服务器新增 `textDocument/references` 与
`textDocument/codeAction`（故意返回 pyright 那种编码形式的 URI），`verify:lsp-protocol`
20→**24**：references 三个位置、请求确实到达、URI 已解码、code action 保留 edit。
`verify:ui-live` 里那两条 SKIP 的 plumbing 因此仍被覆盖。

**击键不等，提问要等。** stub 没有 references、没有 quick fix、goto 只是文件内启发式，所以会话
第一秒里的 Ctrl+B / Alt+F7 / Alt+Enter 会得到「没找到」。这类**显式动作**现在会等接管完成
（`waitForUpgrade`，上限 10s），并且会提前放行那 300 ms 延迟（`startUpgradeNow`）——它本来
就在等。补全与 hover 仍然走 stub，不等。门禁用 `list.append` 做判据：它的定义在 pyright 的
typeshed 里，stub 的文件内启发式不可能答对，实测 1743 ms 返回 `builtins.pyi`。

**接管是被内容证明的，不是被状态字段证明的。** 对同一个位置做两次同样的请求：stub 的 `pri` 补全 30 项（`Exception` / `False` / `None`…）、hover 是 `**builtin** print`；接管后同一个 `pri` 是 8 项（`copyright` / `StopIteration`…）、hover 是 `(function) def print(...)`。断言要求**两个方向都有差异**（`+copyright −Exception`），所以「`slot.lsp` 换成 pyright、请求还落在 stub 上」这种 bug 会让门禁红——只断言 `serverName === 'pyright'` 是永远看不出来的。

**三个只有跑起来才会遇到的 bug：**

| 问题 | 现象 | 修法 |
|---|---|---|
| **只有 stub 可用时两段式会起两个 stub** | `launch` 本身就是 fallback，两段式把它当"真服务"再起一次——多一个进程、多一份内存 | 记录 `fromStub`，只有真服务存在时才分两层 |
| **`.cmd` 包装器杀不掉** | pyright / tsserver 是 `cmd /d /s /c node …`；`child.kill()` 只杀 cmd，真服务继续持有管道，**父进程因此永不退出**（套件打印完摘要就挂住） | `killTree`（`taskkill /T /F`）下沉到 `src/util/killTree.ts`，`LspClient.stop()` 在优雅退出超时后走它 |
| **"稳定"被平台期骗过** | 计数 1.5 s 不变就判定 stable，于是 rust 的 16 项被当成终值 | `measureStartup` 接受 `expectItems`（来自基线），等到基线的项数再判稳定 |

`verify:startup` 27 项：基线形状与覆盖率（每个声明了服务的语言必须有条目，加了语言不写基线会红）、python 的五条契约（启动不起服务 / 首次击键由 stub 答 / stub 的 hover 是 stub 的 / 真服务接管且**答案内容随之改变** / 接管后 hover 换成真服务的签名）、以及每个语言的 `stable`。宿主繁忙时绝对数字会整体漂移 2–4 倍，所以门禁取**多次独立冷启动里最好的一次**，并对已知冷成本大的语言（java 每次清空 Eclipse workspace、rust 每次重建索引）用显式 `gateMs`。

端到端：装好的 exe 启动到 `/health` 从 **1055–1118 ms 降到 593–634 ms**，而且那一刻**没有任何语言服务子进程**。

`npm test` 151→**157**（+6：缓存命中、签名失效、参数不同、失败不缓存、缺失二进制、损坏缓存文件）。

### 补全质量：短字段、签名提示、按需文档

补全之前只回 `label` 和 `kind`，所以客户端拿不到「服务端想让你插入什么」「该排在哪」「文档是什么」。三处改动，都是透传而不是自造：

| 项 | 之前 | 现在 |
|---|---|---|
| 插入文本 | 只能插 `label`，`foo(x, y)` 变成 `foo` | 转发 `insertText` / `sortText` / `filterText`，客户端按 `sortText` 排序并展开 `$1` / `${1:name}` 片段 |
| 签名提示 | 无 | `signatureHelp` 全链路：只在 `(` / `,` 触发，150 ms 去抖，`requestId` 过期丢弃，服务端未声明能力时回 `unsupported` 而不是空框 |
| 文档 | 无 | `completionItem/resolve`：列表帧不带 docstring（100 项 × 300 字符 ≈ 30 KB/帧），选中才取一次 |

修了一个由第 3 项引入、只有真跑才会发现的崩溃：`CMP.docs` 从未初始化，`verify-pycharm` 一进补全就 `Cannot read properties of undefined (reading 'print')`。文档缓存也按语言清空——同名 label 在两种语言里是两回事。

### 依赖：读得懂、装得上、装完能看见

之前产品里**没有任何依赖管理**（`pip install` / `npm install` / `go get` 在 `src/` 里零命中），所以「装了包就有补全」这件事从来没成立过。现在按 manifest 声明实现，没有一处按语言名分支：

```jsonc
"dependencies": { "format": "requirements", "files": ["requirements.txt", "pyproject.toml"],
                  "install": ["{toolchain}", "-m", "pip", "install"] }
```

- **读**：`readDependencies` 按 `format` 选解析器（requirements / go.mod / package.json），只读项目根，清单里越界的 `files` 条目直接跳过而不是解析。
- **装**：`installPackage` 用清单的 `install` 前缀 + 包名，`spawn` 直连（不经 shell），输出流式回传、2 MiB 封顶、可取消；连接断开时 SIGTERM 掉，不留半个 `pip install` 在后台改项目。以 `-` 开头的包名一律拒绝——`pip install -r x` 会去装一个文件。
- **刷**：装成功后 `releaseLsp` + `ensureLsp` 只重启该语言的服务（实测 412 ms），因为服务端缓存了导入图。探针实测：重启前 `ready`，重启后仍 `ready`，并且**能继续报出** `'undefined_name' is not defined` —— 只把状态改回 `ready` 而不真正重连，这条会退化成空诊断，探针正是为它写的。没有服务端的语言（markdown）返回 `{"ok":false,"error":"marksman not installed…"}`，不会挂住。

界面是底部工具窗 **Packages（Alt+6）**：声明清单 + 版本、未声明导入（标 `not declared`，点 Use 填入输入框）、安装输入框、输出台。切文件/切语言会重读，不会把 python 的包显示在 go 下面。

### 落点与门禁

| 项 | 位置 |
|---|---|
| 补全短字段 | `handlers/languages.ts` · `30-panels.js`（`expandSnippet` / `sortText` 排序） |
| `signatureHelp` | `LspClient` → `WorkspaceService` → `handleSignatureHelp` → `68-nav.js` |
| `completionItem/resolve` | `resolveCompletion` → `handleCompletionResolve` → `cmpOnDetail` |
| 依赖读/装 | `src/langs/dependencies.ts` |
| 装后刷新 | `WorkspaceService.restartLanguageServer` |
| Packages 窗 | `40-docks.js` + `pycharm-css.ts` |

- `tests/pure.test.ts` +18（共 **119**）：三种格式的解析、未声明导入、包名白名单、`{toolchain}` 展开、非零退出码、子进程句柄外露。
- `verify-ide` +9（共 **72**）：真读仓库自己的 `package.json`（8 个包）、未声明导入命中、拒绝 `-r`、空转取消。
- `verify-pycharm` +16（共 **327**）：Packages 窗的请求、渲染、Use→Install 流转、输出流、装完重读、跨语言过期帧丢弃。
- `verify:langparity` 7/7，`verify:arch` 18/18（169 files · 488 imports），`ci:pure` 413/413。

### 打包产物实测（`dist/Nolanguage.exe`，85.0 MiB）

`build:exe` 重建后逐项验，全部对着**打包好的二进制**跑，不是对着源码：

| 套件 | 结果 | 覆盖 |
|---|---|---|
| 新增 `verify:packages-exe` | **29/29** | 依赖读/装/刷的完整链路 + 补全三件套 |
| `verify:ui-live`（真 Edge + CDP） | 11/11 | 五个导航键在打包产物里仍然可用 |
| `verify:smoke` | 27/27（2 skip） | 六个页面、Python 真执行、SQLite、日志落盘、扩展宿主 |
| `verify:mcp-exe` | 30/30 | MCP 五种卡片状态 |

新套件要解决的是「`pip install` 要联网」这个矛盾：往临时工程写一个 **project tier 插件**（`<workspace>/.nolanguage/languages/pkgpy@1.0.0`），内容是 Python 清单的副本，只改两处——新 id，和 `install: [node, -e, "console.log('installed ' + process.argv[1])"]`。语言服务器、工具链发现、`{toolchain}` 展开全是真的，所以安装走的是真代码路径，装完重启的是真语言服务器。全程不联网。

实测到的关键几条：

```
PASS  a successful install restarts the language server  — {"ok":true}
PASS  the restarted server still answers diagnostics  — 2 item(s)
PASS  signatureHelp returns real signatures  — print(args, sep, end, file, flush)
PASS  signatureHelp names the active parameter  — 1
PASS  completionItemDetail comes back for a builtin  — {"detail":"builtin", ...}
PASS  the reply names the command it ran  — node.exe -e console.log(...) requests
```

装完重启后仍然报出 `undefined_name` —— 这条是刻意加的：如果 `restartLanguageServer` 只是把状态改回 `ready` 而没有真重连，诊断会退化成空列表，只有这条能抓到。

启动日志里只有两条 WARN，都与本轮无关：scratch home 下 SQLite 退化成内存态、冷启动 LSP `initialize` 312 ms 超 60 ms 阈值。

顺带印证了一个设计选择：日志里 javascript 的工具链被解析成 `Nolanguage.exe` 自己（exe 就是 Node 运行时），所以 JS 的安装命令必须是 `npm install` 而不是 `{toolchain} install` —— 后者会变成 `Nolanguage.exe install <pkg>`。

### 把八种语言的服务真的装上，然后测：五个 bug

语义基线原本只覆盖五个语言，其余三个（markdown / c / cpp）是「没装服务」的 SKIP。这一轮把它们装上——用产品自己的 `nlg lang server install`——于是基线变成八种语言，并且**装的过程本身抓到了五个 bug**。

装法（三条路径都走了一遍）：

| 语言 | 服务 | 方式 |
|---|---|---|
| python | pyright | `nlg lang server install python`（npm，产品自己的命令） |
| go | gopls | `lang server install go`（`go install`，装完在 `servers/go/bin/gopls.exe`） |
| javascript | tsserver | `lang server install javascript`（npm） |
| markdown | marksman | GitHub release 在本机被代理挡住 → `winget install Artempyanykh.Marksman`，再复制进 `servers/markdown/marksman.exe` |
| c / cpp | clangd | 同上 → `winget install LLVM.clangd`（独立包，不是整个 LLVM） |

装完 `nlg lang server` 从「4 of 4 missing」变成「2 of 4 missing」再到全部 `managed`——托管根解析是通的。

**五个 bug，全部是「装一下才看得见」：**

| 问题 | 现象 | 修法 |
|---|---|---|
| **markdown 的 `lsp.args` 是空的** | marksman 的唯一子命令是 `server`；不给它就打印帮助、什么都不答。**这条语言服务从来没有真正工作过**，而界面上只表现为「markdown 没有补全」 | `builtin/markdown@1.0.0` 加 `"args": ["server"]` |
| **`go install` 用裸名 `go`** | Go 装在 `D://Go lang\bin`（不在 PATH）时，`lang server install go` 报 `'go' 不是内部或外部命令`。而 `run.discovery` 里明明写着它的路径——discovery 存在的意义就是这个场景 | 安装器用 `discoverBinary(manifest.run.discovery)` 的绝对路径 |
| **安装器 `shell: true` 拆开带空格的路径** | 上一条修好后立刻撞上：`D:/Go lang/bin/go.exe` 被 cmd 拆成 `D:/Go`。npm 的 `.cmd` 需要 shell，`go.exe` 不需要 | 改用 `planSpawn`（它本来就负责这两件事：`.cmd` 走 shell、参数加引号） |
| **jdtls 的 `-data` 按插件共享** | 两个项目（或上一个实例没退干净）共用一个 Eclipse workspace 时，第二个 jdtls **握手成功、然后永远不导入工程**——每个请求返回空，没有任何报错。语义基线里 java 就这样从 58 项变成 0 项 | 新增 `{rootHash}` 占位符（根的稳定短哈希），manifest 用 `-data {dataDir}/{rootHash}`；同一项目重开仍复用索引 |
| **`toolchainEnv('java')` 把 `.` 插进 PATH** | 裸命令名的 `dirname` 是 `.`，于是子进程 PATH 以工作目录开头——既是安全气味，也让 jdtls 的行为变了 | 裸命令名直接返回 `undefined`（它本来就是从 PATH 找到的） |
| **jdtls 的 workspace 不能复用** | 按根隔离后仍有一半命中：**同一个项目重开**时第二次 jdtls 一样握手成功、什么都不答。`-Dosgi.locking=none` 无效 | `{dataDir}` 由适配器按根分配，插件声明 `lsp.freshDataDir: true` 每次启动前清空。代价是每次重开都要重新导入（小 pom 2–5 s），换「第二次打开不会得到哑服务器」 |
| **`stop()` 发完 `exit` 立刻 kill** | JVM 来不及走完协议里的干净关闭；日志里一直是 `exited {code: null}`（被信号杀掉） | 先等 1.5 s 让它自己退，退不掉才 kill |

**语义基线现在是八种语言、23 项**（`verify:lsp-semantics`）。python 装上 pyright 后走真后端：补全 8 项、hover `(function) def print(...)`、诊断 `Expected parameter name`；没装 pyright 时仍然落到内置 stub（`builtin` / `SyntaxError`），所以断言写成「任一命中」而不是放宽成非空。markdown 只有两条（marksman 没有链接 hover，如实 SKIP）。

**启动耗时表补全**（同口径，2 次采样）：

| 语言 | 服务 | `initialize` | 首次有结果的补全 |
|---|---|---|---|
| c / cpp | clangd | **81–88 ms** | 7–12 ms |
| rust | rust-analyzer | 77–93 ms | 1032–1036 ms |
| javascript | tsserver | 246–279 ms | 450–460 ms |
| python | pyright | 261–265 ms | 796 ms |
| go | gopls | 340–374 ms | 420–453 ms |
| markdown | marksman | 914–938 ms | 34 ms |
| java | jdtls | 2017–3392 ms | 1535–1610 ms |

**装上服务之后，三个套件暴露了自己不隔离环境。** `verify-markdown` 断言「marksman 不存在」、`verify-javascript` 用 PATH-only 的发现去猜工作区会不会有服务、`verify-ide` 断言 stub 才有的「未使用 import」——它们此前是绿的，只因为机器是空的。现在都改成按实际状态断言（或与产品同口径解析），装与不装都成立。

`npm test` 149→**151**（+2：按根隔离的 `{dataDir}`、无法解析的模板拒绝启动）。`verify` **2385/2385 · 52 套件**全绿，且连续跑三次结果一致。

### LSP 协议与语义基线：把「能跑」拆成「行为对」和「结果对」

启动耗时测完只说明服务器答应了，没说明它答得对。这一轮补三组测试，并把过程中发现的两处漏接修掉。

**`verify:lsp-protocol`（20 项，不依赖任何真实服务器）。** 假服务器现在可以对指定方法**永不回答**（`--hang`）、在收到指定方法时**直接退出**（`--die-on`）、把 `initialize` 的 options 写进日志（`--log-init`）。于是每条断言都是关于管理器的决策，而不是某个服务器的脾气：

| 场景 | 实测 |
|---|---|
| 连击 5 次补全 | 5 个请求全部到达、4 个被 `$/cancelRequest` 取消、1 个带结果 |
| 3 次相同定义 | 1 次往返 |
| 补全永不回答 | **407 ms** 返回兜底（预算 400），不挂起 |
| 显式动作永不回答 | `unsupported: timed out`，**309 ms** |
| 请求途中服务器退出 | 请求 **12 ms** 落定、进程存活、条目报 `exited (code 7)`、后续走兜底、**不按请求重启** |
| 能力契约 | 声明了就能答；`documentFormattingProvider: false` → `does not advertise format` 而不是空列表 |

其中一条是**记录现状而不是断言好**：产品**没有发送侧 debounce**。每次触发都发请求，客户端先用本地 L1 列表顶上，管理器取消上一个。「5 请求 / 4 取消」就是这个设计的成本，写成断言让将来的改动可见——真要加 debounce 是产品决策（每次补全多 50 ms），不是修 bug。

**Java 冷启动的降级，第一次被证明真的生效。** 之前那次「首次补全 506 ms / 90 项」其实是 jdtls 抢在预算内答完了，兜底没被触发。现在用**第二个根**（没有热服务器）测：第一次击键 **504 ms** 拿到 90 项**词法兜底**结果（`App` / `String` / `System`…），jdtls 导入完成后 **4849 ms** 起真成员（`add(String)`…）接管。`initialize` 完成 ≠ 能用——这中间的 4 秒正是预算存在的理由。

**`verify:lsp-semantics`（15 项，五种语言各三条）。** 每语言一份固定 fixture，三条断言都带具体期望值：补全必须含某个成员、hover 必须含类型签名、诊断必须含服务器自己的措辞。

| 语言 | 补全 | hover | 诊断 |
|---|---|---|---|
| python（stub） | `print`（30 项） | `builtin` | `SyntaxError` |
| go（gopls） | `Println`（`fmt.` → 29 项） | `func fmt.Println` | `undefined` |
| javascript | `filter`（23 项） | `number[]` | `Expression expected` |
| rust | `as_bytes`（138 项） | `let s: String` | `mismatched types` |
| java | `add(`（58 项） | `List<String> names` | `cannot be resolved` |

**两个数字的来历，因为容易被误读。** Go 的「3 项」不是质量问题：早期探针把光标放在 `fmt.Println` 内部，得到前缀过滤后的 3 项；放在 `fmt.` 之后是 **29 项**（完整导出面）。Python 的「30 项」是 stub 的天花板：`json.` / `str.` / `x.` 返回**完全相同的 30 个名字**，它不看点号左边——这是「内置兜底」的定义，装上 pyright 才有成员解析。

**试过但没采用的调优：`cachePriming.enable = false`。** 交替采样（4 轮，每次新项目 + 新服务器）：默认 818–1057 ms，关闭 820–1056 ms，区间完全重叠。**没改 manifest。** 第一轮不交替时看到过「1.9–4.9 s」，那是首跑冷盘的采样偏差——顺序会污染结果。

**顺带修掉两处漏接：**

| 问题 | 现象 |
|---|---|
| `lsp.initializationOptions` 在旧路径上被丢弃 | 只有池化路径读它；`rust@1.0.0` 这类非 manager 插件声明了也不生效。现在两条路径都传 |
| 服务器崩溃后 `describe()` 不说原因 | 状态栏只能显示「未运行」，与「从未配置」无法区分。现在记 `language server exited (code N)` |

### 池化语言服务管理器（Java 为第一个真实插件）

一份方案要求用 **Rust** 写一个 `LspManager`（`inventory` 编译期注册、`trait LanguagePlugin`、`Arc<Mutex>`）。产品是 TypeScript 内核 + SEA 单文件，`src-tauri/` 只有 457 行外壳且不随包分发，`LspClient` / `check` / Problems 面板全在 TS 里。所以按**接口等价**实现，并把理由写进 `docs/lsp-manager.md` 第一节：`trait` → `interface`、`&'static str` → 冻结字段、`inventory` → 静态表 + 注册表扫描、`Arc<Mutex>` → 单线程事件循环。

管理器本身是语言无关的（`src/lsp/manager/`，10 个文件）：池化、根收敛、懒启动、latest-only + `$/cancelRequest`、去重、聚合、版本签名、增量失效、词法降级、诊断上限。语言知识全部落在 manifest：`lsp.manager` / `projectMarkers` / `command` 模板 / `initializationOptions` / `idleTtlMs` / `firstRequestBudgetMs` / `incremental` / `fallback`。**核心层没有任何 `if language == "java"`**，`verify-langparity` 的字面量预算也没动。

`slot.lsp` 的类型从 `LspClient` 换成 `LspLike`，`LspClient` 与 `ManagedLsp` 都结构满足它——所以**面板里没有一行管理器分支**。Java 通过 `"manager": true` 走新路径，其余七种仍是原来的一条客户端，迁移是每种一行。

**三个只有真服务器才暴露的问题：**

| 问题 | 现象 | 修法 |
|---|---|---|
| **jdtls 的 `.bat` 根本不能 spawn** | 本机 `bin/jdtls.bat` 是 `python jdtls %*` 加一行 `pause`——spawn 它永久阻塞。也就是说「用发现的二进制启动」这个假设对 jdtls 完全不成立 | manifest 新增 `lsp.command` 模板：`{toolchain}` / `{dist}` / `{platform}` / `{dataDir}` / `{glob:…}`，jdtls 声明成 `java -jar …/equinox.launcher_*.jar` |
| **`initializationOptions` 被硬编码成 `{}`** | 任何需要初始化配置才有用的服务器（jdtls 的 `java.import.mode`）都拿不到配置，插件也无法影响 | `LspLaunchSpec` 加字段并透传 |
| **没有请求取消** | `JsonRpcConnection.request` 不返回 id，`$/cancelRequest` 无从谈起；连击时旧答案会覆盖新答案 | `request(method, params, onId)` + `cancel(id)` + `LspClient.cancelRequest`，调度器按单调序号丢弃过期结果 |

**两个量出来的数字：** jdtls `initialize` 2.6–2.9 s，Maven 导入 4.9–5.2 s，热补全 53–62 ms。所以 `firstRequestBudgetMs` 默认 500 ms——第一次击键由词法兜底回答，服务就绪后自动切换；`navBudgetMs` 5 s 给显式动作。没有这个预算，打开一个 Maven 工程后的第一次补全会卡近 5 秒。

新增 `verify:lsp-manager`（`scripts/verify-lsp-manager.ts`）：纯逻辑 + 假服务器（`scripts/fixtures/fake-lsp.mjs`，记录每个收到的方法，所以「取消确实转发了」是断言而不是期望）+ 真 jdtls（缺失时 SKIP）+ stdio 测试服务（`scripts/lsp-manager-service.ts`）。已进 `verify-all`（50 套件）与 CI。`npm test` 也补了管理器单测。

### P0 · 语言服务按需下载（`nlg lang server`）

产品不分发语言服务，于是「八种语言」实际只有两种有智能，而那两种是手动装进 `.tmp/langdeps` 的。这一轮补上缺失的另一半：**插件声明服务从哪来，CLI 逐语言说清缺什么、多大、怎么装**。

```bash
nlg lang server                 # 一张表：ID / SERVER / FOUND / WHERE / MEMORY / HOW
nlg lang server install python  # 真的装（npm / go），或告诉你为什么不能自动装
```

实测输出（装之前）：

```
ID          SERVER    FOUND    WHERE    MEMORY  HOW
go          gopls     MISSING  missing  80MB    go install golang.org/x/tools/gopls@v0.24.0
javascript  tsserver  MISSING  missing  150MB   npm install --prefix <home>/servers/javascript … typescript-language-server@6.1.0
markdown    marksman  MISSING  missing  20MB    see `lang server install markdown`
python      pyright   MISSING  missing  380MB   npm install --prefix <home>/servers/python … pyright@1.1.414
```

**三条设计约束，都是有理由的：**

| 约束 | 理由 |
|---|---|
| 只调 `npm` / `go`，**不自己下二进制** | 这两个包管理器自己校验（npm integrity、Go 校验数据库）。GitHub release 没有可校验的 hash，所以 `github` 类只打印 releases 页面和目标路径，**不代下** |
| `version` 必填（github 除外） | 不 pin 的版本 = 装「今天注册表给的那个」，出了问题无法复现 |
| 托管目录只做**兜底** | `<home>/servers/<id>` 只在 `discovery` 找不到时才查。用户设了 `PYTHON_BIN` 就是告诉我们用哪个，不能被托管副本覆盖 |

`verify:server-install`（15 项）跑完整条链路，验收标准就是当初承诺的那条：**装完之后不设任何环境变量**，面板里 `nums.` 拿到 **25 项真实成员补全**（`concat/every/filter/…`），而不是 stub 的 31 个内置名。

写这套测试时又踩了一次「环境伪装成产品 bug」：第一次跑 `lang server install` 报 npm EPERM——是沙箱拦了 `%LOCALAPPDATA%\npm-cache`，不是安装器的问题。测试里把 `npm_config_cache` 指进仓库就好了。

### P1 · 测试按钮：后端早就有，缺的是入口

`handlers/run.ts:207` 一直接受 `mode: 'test'`，`go test` / `rustc --test` / `javac` 的路径全在，`supportsTest` 也一直从 manifest 传到 `workspace` 帧——**客户端从来没发过这个字段**。

现在：工具栏多了 **Test** 按钮（只在插件声明了 `test` 模式时出现），快捷键 **Ctrl+Shift+F10**（Shift+F10 仍是 Run，与 PyCharm 的「run context」一致），`runCode(mode)` 把 `mode` 带上。

`verify:lang-plugin` 从 39 项扩到 **43** 项，四种语言的 test 模式逐个真跑：`cpp bin=g++` / `c bin=gcc` / `rust bin=rustc` / `java bin=java`，全部 exit 0。

### P1 · 格式化走语言服务（并修掉一个把所有人都挡住的 bug）

`Ctrl+Alt+L` 和菜单项一直都在，但它调的是 `basicFormat()`——一个手写的缩进整理器。现在先问 `textDocument/formatting`，服务端不支持才退回本地，并在 toast 里说明是「Reformatted locally」。

**写这条链时发现 `declaresFeature()` 把 key 猜错了**：它对所有特性都用 `${feature}Provider`，而 LSP 的格式化能力叫 **`documentFormattingProvider`**。于是 `format` 永远被判为「服务不支持」——也就是说，**即使装上 pyright/gopls，格式化也永远不会走服务**。改成显式映射后，tsserver 立刻返回 **9 处编辑**（`verify:langs-real` 新增两项断言）。

客户端新增 `applyTextEdits()`：从后往前应用，避免偏移失效；LSP 的 line/character 正好是 JS 字符串的索引单位，不需要编码转换。

`verify:ui-live` 加了两项：`Ctrl+Alt+L` 真的改写了缓冲区（尾随空格被清掉），且 toast 说明是本地完成的（Python 的 stub 不支持格式化）。

### L0 波浪线：本来就有，这次才被证明

一份改进计划把「语法检查 L0（CodeMirror linter + lintGutter）」列为 P0.5、工期 0.5–1 天，理由是「客户端有 lint 级诊断但没渲染，编辑器里没有波浪线」。**这条前提是错的。**

`40-docks.js` 的 `setDiags()` 一直在调 `paintDiagMarks()`：`cm.markText` 打 `diag-sq`（`pycharm-css.ts` 里是 `text-decoration: underline wavy`，按 severity 上色），`cm.addLineClass` 打 `diag-g1/2/3` 行号槽底色；`50-runtime.js` 还有 300ms 去抖的 check-as-you-type。缺的从来不是渲染。

现在 `verify:ui-live` 用真 Edge + CDP 把这件事钉住（11 → **17** 项）：

```
PASS  a syntax error paints a squiggle in the editor  — {"squiggles":1,"gutter":2,"problems":1,"status":"1 problem"}
PASS  the gutter carries the same severity  — 2 line(s)
PASS  the Problems panel agrees with the editor  — 1 row(s)
PASS  the status bar counts the same problems  — 1 problem
PASS  fixing the file clears the squiggles  — 0 left
```

写完之后再回头看那份计划，另外两条也偏了：

- **「测试运行器」不是「三种语言不能跑单测」**：`handlers/run.ts` 早就接受 `mode: 'test'`，`go test` / `rustc --test` / `javac` 的路径都在，缺的只是一个按钮。
- **「Go 覆盖率」不是纯 manifest 改动**：`handlers/perf.ts` 的 `coverage()` 无论哪个语言都调 `runPythonCoverage`。给 Go 写上 `coverage: true` 会拿 Python 的 `trace` 去打 `go` 编译器——需要的是按 runtime 分派的实现，而不是一个布尔字段。

### 一次装四种语言：C++ / C / Rust / Java

`examples/` 原来只有 `cpp`，这一轮补齐成四种，全部走同一条 `nlg lang add` 路径装进临时 home，然后在应用里真编译、真运行：

| 语言 | 编译器 | 语言服务 | 实测 |
|---|---|---|---|
| C++ | g++ | clangd（缺） | `cpp 42`，exit 0；导航说 clangd 缺失 |
| C | gcc | clangd（缺） | `c 42`，exit 0；同上 |
| **Rust** | rustc | **rust-analyzer（有）** | `rust 42`，exit 0；补全 **100 项**（`into_bytes()` / `leak()` …），定义跳到 `fn add` |
| Java | java | jdtls（缺） | `java 42`，exit 0（单文件源码启动器，无构建步骤） |

`verify:lang-plugin` 从 19 项扩到 **39 项**，一次装四种、逐个验。八种语言同窗：`python,go,javascript,markdown,cpp,c,rust,java`。

三个实现细节值得记：

- **C 只声明 `.c`，不要 `.h`。** `.h` 同时属于 C 和 C++，C++ 插件已经占了它；两个插件抢同一个扩展名，扩展名解析就会看加载顺序。宁可 C 少一个扩展名。
- **Java 用单文件源码启动器**（`java Main.java`，JDK 11+），一步跑完，不需要 classpath、不需要 `javac` 两步、也不受「public 类名必须等于文件名」的约束——实测 `main.java` 里写 `public class Main` 能跑。少一个 `{toolchain}` 之外的工具，就少一处「装了 JDK 但 javac 不在 PATH」的坑。
- **rust-analyzer 必须有 Cargo 项目。** 第一次跑时它报 `failed to find any projects in [.../rust]`，然后每条请求都在 1 ms 内返回 0 项——看起来像「补全坏了」，实际是它根本没有工作区。给插件加 `scaffold.onFirstRun` 写一个最小 `Cargo.toml`（`[[bin]] path = "main.rs"`，让 `rustc` 直接编译同一个文件）之后，`failed to fetch workspace` 消失。**还有一个冷启动窗口**：RA 载入 crate 之前会立刻回空列表，之后才是 138 项——所以套件里加了「问到有结果或超时为止」，而不是把第一次的空结果当成失败。

### 用 `nlg` 装一门语言，然后在软件里用它

`nlg lang add` 是没上市场的插件唯一的分发方式：一个目录 + 一份 manifest。这一轮把它整条链路走通了，新增 `verify:lang-plugin`（19 项）：

```bash
nlg lang ls  --home <tmp>                      # 4 个内置
nlg lang add examples/cpp@1.0.0 --home <tmp>   # added cpp@1.0.0 · requires template@^1.0.0 (met)
nlg lang ls  --home <tmp>                      # cpp 1.0.0 user user yes template cpp cc cxx …
```

然后用同一个 home 启动应用，C++ 就是一等公民了：

```
languages   python,go,javascript,markdown,cpp
cpp slot    main.cpp · template · supportsRun=true
toolchains  cpp=g++（发现成功）
run         exit=0  "cpp 42"        ← g++ -std=c++17 编译后真跑
check       fromLsp=false · clangd not installed - Run works, Check and completion do not
definition  unsupported：同上
deps        supported=false（该插件没声明依赖文件）
```

也就是说：**一个原本不在产品里的语言，装进来就能编译、能跑、能诚实地说清自己缺什么**。之后 `lang disable` 翻标志、`lang uninstall` 删除本体，`ls` 随之变化。

**顺带修掉一个会撒谎的返回值**：`Registry.uninstall` 原来是 `rm(dir, {recursive:true, force:true}).catch(() => undefined)`，然后无条件 `return true`。目录删不掉（被运行中的 IDE 占着、权限墙、只读卷）时，CLI 照样打印 `uninstalled`、退出码 0，而插件仍在磁盘上、仍在列表里。现在把失败抛出去：实测输出 `lang: could not remove <dir>: … EPERM …`、**退出码 1**、列表如实保留该插件。

写这个套件时还踩了一次自己的坑：第一次跑 `uninstall` 失败，我以为是产品 bug，实际是这台机器的批量删除守卫拒绝了递归删除（`SAFE_DELETE_BULK_GUARD_ERROR`）。现在套件把「环境拒绝删除」和「产品漏删」分开：前者断言「必须如实报错」并 SKIP 掉「目录已消失」，后者才是 FAIL。

### 装上真语言服务之后：两个只有真服务才暴露的 bug

`verify-langs-exe` 证明「没装服务时说得很清楚」。这一轮把服务真的装上，验证另一端——装上了到底能不能用。全部装在仓库内的 `.tmp/langdeps`，不碰系统环境：

```bash
npm install --prefix .tmp/langdeps typescript-language-server typescript
GOBIN=<abs>/.tmp/langdeps/bin GOPROXY=https://goproxy.cn \
  go install golang.org/x/tools/gopls@latest        # 官方 proxy 在本机被挡，镜像可用
```

然后新增 `verify:langs-real`（16 项，服务器缺失时 SKIP），结果：

| 能力 | JavaScript（tsserver） | Go（gopls） |
|---|---|---|
| 成员补全 | `nums.` → **28 项**，`concat/every/filter/forEach/…` | `fmt.` → **29 项**，`Append/Appendf/Appendln/Errorf/…` |
| 参数提示 | `max(...values: number[]): number` | — |
| 跳转定义 | 跳到 `function sum`（line 0） | `fmt` 解析到包声明 |
| 查找引用 | 2 处 | — |
| 符号重命名 | 2 处编辑，都改成 `total` | — |
| 快速修复 | 「Move to a new file」 | — |
| 全局符号 | `sum` | `Add` |
| 诊断 | 语法错误 1 条 | `undefined: undefinedThing` |

**关键对比**：没有服务时 `json.` 和 `requests.` 返回**同一批 31 个内置名**；现在 `nums.` 是 28 个**数组方法**——成员解析是真的在工作。

两个 bug 都是这一轮才浮出来的，且都做了注入验证：

| 问题 | 现象 | 修法 |
|---|---|---|
| **`.cmd` 起不来** | 装好 tsserver/gopls 后，所有请求回 `spawn EINVAL`。Windows 上每个 npm 分发的语言服务（`typescript-language-server`、`pyright-langserver`、`vscode-*-server`）都是 `.cmd` 垫片：裸名 `ENOENT`（CreateProcess 不看 PATHEXT），`.cmd` 本身 `EINVAL`（那是给 cmd.exe 的脚本，不是镜像）。**也就是说「用 npm 装的语言服务」在 Windows 上从来没能启动过** | 把 MCP 早就写好的解析器搬出来共用：`src/mcp/spawn-command.ts` → `src/util/spawnPlan.ts`（`lsp` 不能 import `mcp`，同层），`LspClient` 用它决定 `command`/`args`/`shell`。注入掉 `shell: plan.shell` → 全套请求回 `spawn EINVAL`，还原后 16/16 |
| **诊断的 URI 对不上** | 服务端日志说「Diagnostics published 1 error」，Check 却报 0 条。tsserver 把文档回显成 `file:///d%3A/...`，我们打开时是 `file:///D:/...`——`Map` 用原始字符串当键，写入和读取永远不相等。Python 的内置 stub 原样回显，所以这条一直藏着 | 新增 `diagnosticKey()`：先 `decodeURIComponent`，Windows 上再折叠大小写；写入与读取都用它。注入掉折叠 → 语法错误变回 0 条，还原后 1 条 |

`verify:langs-real` 支持 `NOLANGUAGE_EXE`，所以同一套检查对**源码**、**`dist/Nolanguage.exe`**、**已安装的 `D://Nolanguage//Nolanguage.exe`** 各跑了一遍，都是 **16/16**。

gopls 的缓存与 `go` 的构建目录要落在仓库内（`LOCALAPPDATA` / `TMP` / `GOCACHE`），否则受限环境里 gopls 会以 `Access is denied` 退出，看起来像「gopls 坏了」。

### 另外三种语言：降级是否诚实（新增 `verify:langs-exe`，16 项）

Python 有内置语言服务，其余三种在本机**一个服务都没有**（gopls / typescript-language-server / marksman 全缺）。所以真正要验的不是「能不能用」，而是**用不了的时候说不说得清**——空列表和「没有服务」在界面上长得一模一样，但只有后者值得处理。

逐语言跑了同样的 8 个 LSP 请求（补全、参数提示、补全文档、定义、引用、重命名、快速修复、全局符号），三种语言**全部 8/8 带着原因**回来，而且用的是各自清单里的措辞：

```
go          gopls not installed — Run works, Check and completion do not
javascript  typescript-language-server not installed — Run works, Check and completion do not
markdown    marksman not installed — rendering, outline and breadcrumbs still work
```

同一条链路上还验了：`go.mod` / `package.json` 的依赖读取、Go 真跑（`3`，exit 0）、JS 真跑（`6`，exit 0）、Markdown 拒绝运行并说明「documents render」、Markdown 在无 marksman 的情况下仍渲染出 `<h1>` 与两条大纲。

**顺带修掉一处不一致**：`complete` 是八个请求里唯一一个把「没有服务」报成 `items: []` 的——其余七个早已用 `unsupported` 区分。现在 `WorkspaceService.complete` 返回 `{ items, unsupported? }`，帧里带上原因；客户端本来就会回退到自己的词表，所以体验不变，只是不再撒谎。

写这个套件时自己踩了一个坑，值得记下来：第一版忘了在请求里带 `language`，而 `asLanguage` 对缺失的 id **不报错、退回默认语言**，于是八条请求全部由 Python 回答、看起来完全正常。是「8/8 都有原因」这条断言把它逼出来的——它要求每条都带 `unsupported`，而 Python 有服务、不该带。

门禁：`verify:langs-exe` 16 项，已加进 `.github/workflows/ci.yml`（`verify:ci` 6/6，15 commands）；对**已安装**的那份跑同样 16/16。

### 安全与缺陷审计（修了四处，报了两处）

按「能读到别人的文件」「能让进程挂掉」「UI 说的和实际不符」三类过了一遍。四处修复都配了门禁，并且都做了**注入违规 → FAIL、还原 → PASS** 的对照。

| 问题 | 严重度 | 修法 |
|---|---|---|
| 工程目录里的**符号链接/junction 能把资源管理器带出工作区**：`link/secret.txt` 的解析路径确实在根下，`readFile` 却跟着链接跑。`realRoot` 字段的注释写着「每次包含性检查的锚点」，`setRoot` 还专门 `realpath` 了它——但**从来没有任何代码读过它** | 高（读+写都越界；工作区里带 junction 的仓库即可触发） | `resolveSafe` 增加 `assertInsideRealRoot`：对**最深的已存在祖先**做 `realpath` 再比对（叶子常常还不存在，`create`/`write` 时 `realpath` 会抛），Windows 上按大小写不敏感比较。指向根内的链接仍然可用（monorepo 合法） |
| **入站 WebSocket 消息没有上限**：64 位长度形式允许声明 2^53 字节的帧，`tryParseFrame` 会一直等那些永远不来的字节，`this.buffer` 无限增长；分片消息的 `fragments` 同样无上限 | 中（本机任意进程可打；`originAllowed` 故意放行无 `Origin` 的原生客户端，所以「只有本应用能连」不成立） | 单帧与分片总量都封 16 MiB（面板最大的合法消息是 4 MiB 文件的 `fsWrite`），超限 `close(1009)` |
| **`pyproject.toml` 被当成 requirements 解析**：`name = "demo"`、`version = "1.0.0"`、`dependencies = [` 等五行被当成五个「包」，真正的 `requests`/`flask` 反而漏掉。而 Python 清单本来就把它列为依赖来源 | 中（每个现代 Python 项目都会看到错误清单，正是模块注释里说的「错的清单比短的清单更有害」） | 新增 `pyproject` 格式（只读 `[project]` 的 `dependencies = [ … ]`，不读 `[build-system]`）；schema 允许 `files` 里每项自带 `format`（`string \| { file, format }`），Python 清单随之更新 |
| **Markdown 自动链接从来没生效**：正则找的是字面 `<`，而那时字符串已经被 `escapeHtml` 成了 `&lt;` | 低（功能静默失效） | 改为匹配转义后的形式，`[^&\s]+` 避免把收尾的 `&gt;` 吞进 URL |

审计确认**没有**问题的部分（都补了或已有门禁）：WebSocket 升级的 Origin 校验（回环主机 + 精确端口，`Origin: null` 拒绝）、Markdown 原始 HTML 转义与 `javascript:`/`data:`/协议相对 URL 的丢弃、插件 `id` 的 `ID_RE` 校验（`dataDir`/`installDir` 无法穿越）、包安装不走 shell 且拒绝 `-` 开头的名字、`fsRead` 4 MiB 上限、调试录像的密钥脱敏。

**报而不修**：`dist/Nolanguage.exe` 的 PE 文件版本资源是 Node 的 `22.22.2`（SEA 从 node.exe 注入，版本资源来自基镜像，产品不读它）；`readDependencies` 在 `stat` 与 `readFile` 之间有 TOCTOU 窗口（本机同用户，收益不抵复杂度）；Markdown 的 `title` 属性未单独转义，仅因「先整体转义再解析链接」的顺序而安全——顺序脆弱但没有现行漏洞。**已知且接受的安全姿态**：回环 WebSocket 没有鉴权 token，本机任意进程都能连（与多数开发服务器一致）。

新增/扩充门禁：`verify-explorer` 75→**79**（链接穿越 7 种操作、超大帧）、`verify-markdown` 48→**57**（9 条 XSS 形状 + 自动链接）、`tests/pure.test.ts` 119→**123**（pyproject 三种形态、按文件 format）、`verify:packages-exe` 29→**34**（打包产物里读 pyproject-only 项目、在真实 WebSocket 上验证链接穿越被拒）。

### 安装包：`installer/Nolanguage-Setup.exe`（21.8 MiB）

本机 NSIS 在 `D:\NSIS`，用 `NSIS_MAKENSIS=D:\NSIS\makensis.exe npm run build:setup` 打出安装包（89.3 MB 载荷压到 22.9 MB，25.6%）。`npm run install:app` 把它装到 `D:\Nolanguage`，`/health` 报 `0.7.24-workspace`，注册表 `DisplayVersion` 报 `0.7.24`。

真跑安装才暴露两个问题，都不是「能编译就算过」能发现的：

| 问题 | 现象 | 修法 |
|---|---|---|
| 冒烟脚本还原开始菜单时会输掉竞争 | `install smoke: ok`，但 `Write-Warning` 说 `could not restore the Start Menu folder: 访问被拒绝`，机器上留下三个指向已删除 `%TEMP%\nl-smoke` 的快捷方式——正是上一版声称修好的那个 bug | 静默 NSIS 卸载器会把自己复制到临时目录后**立即返回**，`-Wait` 等到的只是存根；真正的卸载还在删开始菜单。再加上 Windows 会短暂锁住刚写的 `.lnk`。改为**重试 12 次 × 400 ms 并校验结果**（备份文件数 vs 还原后的文件数），而不是假定复制成功 |
| 安装包登记的版本号是硬编码的 | 应用是 0.7.24，Add/Remove Programs 里却写 `0.7.23` | 版本号在 `Nolanguage.nsi` 里另有一份拷贝。改成 `!ifndef APP_VERSION` 兜底 + `build-setup.mjs` 从 `package.json` 传 `/DAPP_VERSION=`，并给 `verify:handshake` 加一条门禁比对两者 |

两个修法都做了对照验证：先建一个带 `marker-a.lnk` / `marker-b.txt` / `sub/nested.txt` 的假开始菜单目录再跑冒烟 —— 修前报 access denied 且文件丢失，修后三个文件（含嵌套）原样还原、无警告；清空后再跑一次，目录被完整删除、机器无残留。

`verify:packages-exe` 新增 `NOLANGUAGE_EXE` 环境变量，可以直接对着**已安装的那份**跑：`NOLANGUAGE_EXE=D:\Nolanguage\Nolanguage.exe npm run verify:packages-exe` → **29/29**，与 `dist/` 里的产物一致。

已知且不打算修的：`dist/Nolanguage.exe` 的 PE 文件版本资源显示 `22.22.2`（Node 的），因为 SEA 是从 node.exe 注入的，版本资源来自基镜像。产品本身从不依赖它——`/health`、install receipt、注册表三处各自正确。



预算门禁在这轮挡下两次：`WorkspaceService.ts` 一度 1209 行、`panel` 一度 27 个文件。做法不是加例外——依赖的读与装搬进 `langs/`（那里本来就有 `discover.ts` 在起子进程），`resourceProfiles` 搬进 `workspace-wire.ts`，两个新增的 panel 文件并回既有文件。

## 0.7.23 — 2026-11-13

### 轻量化优化（SEA、空闲 worker、数据增长上限）

围绕可复核的成本分四层处理：

1. **发包体积**：主进程 bundle `minify: true`，release 默认不嵌 inline sourcemap；需要调试映射时设 `NOLANGUAGE_DEBUG_SOURCEMAP=1`。应用 bundle 重建前约 5.50 MiB，其中 map 约 3.65 MiB；必须以本版完整产物实测净体积。
2. **按需启动**：sandbox `SANDBOX_MIN` 默认 0（普通 IDE Run 本来就走 WorkspaceService，不依赖 MCP warm pool）；Python LSP 保持 eager（主语言需要即时 Check/Complete），非主语言 LSP 可按需启动。
3. **资源上限**：sandbox 默认最多 8 个 worker/Go session；命名 session 不会自动清状态，达到上限会明确要求 reset 或调整 `SANDBOX_MAX_WORKERS`。未命名临时 session 5 分钟空闲后回收；`SANDBOX_SESSION_IDLE=0` 禁用此回收。并发不同 session 的容量预留串行化，避免刚好同时抢过上限。关闭 ExecService 也清理 Go scratch sessions。预热上限仍受 `SANDBOX_MIN` / per-language idle `maxSize` 约束。
4. **长期数据/前端**：语言内存估算把未运行 LSP 的 hint 从活动总量排除；非可回收 runner/profiler 估算已超预算时，不再为了“省”总预算误杀所有 LSP。子进程返回捕获每 stream 4 MiB、telemetry 每 run 10,000 行，显示截断标记；IDE run console DOM 512 Ki chars，Find 去抖并限制 1,000 个匹配 / 16 Mi characters；>1 Mi-character 文件暂缓实时诊断而仍可运行。日志保留后台首轮延迟 60s、每批 500 行，整完 1s 续批、无积压后每 6h 轮转。Git forced probes 共用正在运行的请求，基线 watcher 把已 probe 结果直接交给 checkpoint，免去二次 Git 子进程。大 HTML 经 gzip 协商并缓存压缩结果。

### 验收原则

这批优化不把压缩磁盘体积等同于运行时 RSS：SEA 基础 Node runtime 仍占最大体积，Tauri 壳也继续使用同一个 engine sidecar。分别报告构建体积、IDE HTML/gzip 传输大小、回归结果；RSS/启动收益未用基准工具测过就不声称下降百分比。

### 验证

- `verify-exec`：51 检查（含 worker limit race、named-session refusal、capture byte/log-line caps、concurrent last-slot admission）
- `verify-pycharm`：311+ 检查（含 512 KiB console、large-file diagnostics pause、Find cap）
- `verify-ide`：gzip negotiation + decompression；`run` 的客户端 `timeoutMs`（生效 + 非法值回退）
- `verify-baseline`：bounded retention batches、Git probe
- `verify-plugins`：active-vs-estimated budget
- Tauri bundle build 与 runtime smoke 结果按本次实测补录；build 成功不表示 WebView2 启动正常。
- 全套回归：`verify-all` 2199/2199 across 49 suites；`npm test` 89/89；`ci:pure` 413/413。

### 第一次真正在 GitHub runner 上跑 CI

仓库推上 GitHub（`XIAOYI0424/Nolanguage`）后 `ci.yml` 才第一次在真正的 `windows-latest` 上执行。**本机全绿不等于 runner 全绿**，两个 job 各暴露一组只在干净机器上出现的问题：

| 位置 | 本机表现 | runner 表现 | 根因 |
|---|---|---|---|
| `verify-sign` catalog 检查 | PASS（本机 catalog 可达） | FAIL `UnknownError` | 全新 runner 上 `Get-AuthenticodeSignature` 查不到 catalog 存储。已改为 `UnknownError` → SKIP；`NotSigned` / `HashMismatch` 仍然 FAIL |
| `resolveGoBin` 回填 | PASS（`D:\Go lang` 绝对路径） | Go 全部 `exit=-1`、`build 0ms` | `resolveGoBin()` 在 PATH 命中时返回裸名 `go`；`GoRunner` 又把它当显式路径回填，`existsSync('go')` 恒假 → 报 `missing`。已让无分隔符的 `preferred` 走 `commandExists` |
| `smoke-exe` / `verify-go` | PASS | FAIL | 断言写死了开发机的 `D:\Go lang\bin\go.exe` 与 `1.27`。已改为「绝对路径或 PATH」+「能解析出 `goX.Y`」 |
| `verify-debugtool` channel | 5+ stacks | 4 stacks | 固定 6 秒窗口里，慢 runner 把前几秒花在 Python 启动上。改为等 sample 程序自己退出（上限 20 秒）——它末尾才打印 `total …`，提前收工会把这条输出截掉 |
| `build:setup` | PASS（本机有 NSIS） | `makensis not found` | 干净 runner 没有 NSIS；能下载它的 `tauri build` 步骤排在建安装包之后（且允许失败）。新增 `npm run ci:nsis`（幂等：已装则 no-op，否则 `choco install nsis`），workflow 在 build:setup 前调用 |

同时确认在 runner 上通过的部分：`npm ci` 从 lockfile 安装、`build:exe` 的 SEA 注入、sidecar 镜像校验、`tsc`、38 个单测、15 个 pure 套件，以及 **`verify` 全套 2147/2147**。

补上 `ci:nsis` 后，`integration` 在 `windows-latest` 上整条走通，包括之前从未在 runner 上跑过的安装冒烟：

```
[ensure-nsis] makensis not found; trying Chocolatey (present on windows-latest)
[ensure-nsis] makensis ready: C:\Program Files (x86)\NSIS\makensis.exe
[build-setup] done -> ...\installer\Nolanguage-Setup.exe (21.8 MiB)
health: status=ok version=0.7.23-workspace pid=9052 exeSize=88989184
install smoke: ok
```

两个 job 全部 success（`Ensure NSIS` → `Build installer` → `Silent install + health smoke` → 产物上传）。这是本项目第一次在真实 runner 上完成「构建 → 全量回归 → 打包 → 安装 → 探活」的闭环。

### 本地软件测试又抓到两个问题

自动化门禁全绿之后，把打包产物当普通软件用了一遍（自写 `.tmp/e2e-pkg.ts`，49 项）：`/health`、6 个页面路由、gzip 协商与 `q=0`、Python/Go/JavaScript 真执行、Go 编译错误、Python 命名空间跨 run 保留、异常后会话存活、Markdown 预览、死循环超时、`resetSession`、kill 后端口释放。两项与预期不符：

| 问题 | 表现 | 修法 |
|---|---|---|
| `run` 丢弃客户端 `timeoutMs` | 传 `timeoutMs: 4000`，实际按 manifest 的 15000ms 超时（实测 15063ms）。`WorkspaceService.run` 本来就支持，`profile` 命令也一直在传，只有 `handleRun` 没转发 | 新增 `src/panel/run-timeout.ts`：`NaN`/`Infinity`/非数字/布尔/数组一律回退成 manifest 默认（`setTimeout(NaN)` 会立刻触发，等于把每次运行秒杀），`0`/负数抬到 500ms，超过 10 分钟压到 10 分钟 |
| `ci:install-smoke` 留下开始菜单 | 每次跑完 `Start Menu\Programs\Nolanguage` 都还在，里面「Uninstall Nolanguage」指向已被删除的目录。脚本只快照/还原注册表和 receipt，漏了开始菜单 | 快照整个目录 → `finally` 还原；原本没有就删掉。两个只有真跑才会发现的坑：`Copy-Item <dir> -Destination <dir>` 在目标仍存在时会把源**嵌套**进去（要复制 `"$src\*"`）；还原失败必须降级成 `Write-Warning`，否则 `finally` 抛错会把「冒烟通过」变成「冒烟失败」 |

两条回归都做了「故意注入违规 → FAIL，还原 → PASS」验证：撤掉 `handleRun` 的转发后，`the client timeout beats the manifest default` 报 `15075ms` 失败；恢复后回到 3030ms。开始菜单的两条分支也分别实测（有则还原、无则清除，跑完 `ls` 为空）。

### MCP 集成实测：Windows 上 `"command": "npx"` 根本起不来

用软件自己的 MCP 面板跑了两轮：一轮对自建 stdio server（40 项，覆盖握手 / 列工具 / 调用 / 工具报错 / 调用超时 / 进程秒退 / 禁用 / 未知 id / 断开 / 按需重连 / 重载配置 / 空配置初始化），一轮对真实的 `@modelcontextprotocol/server-filesystem`。第一轮 40/40 通过，第二轮直接暴露一个 Windows 专属缺陷：

```
FAIL  real MCP server connects with command "npx"  — process error: spawn npx ENOENT
```

实测三种写法：

| 写法 | 结果 | 原因 |
|---|---|---|
| `spawn('npx')` | `ENOENT` | CreateProcess 不查 `PATHEXT`，找不到 `npx.cmd` |
| `spawn('npx.cmd')` | `EINVAL` | `.cmd` 是给 cmd.exe 的脚本，不是加载器能起的镜像 |
| `spawn('npx', {shell:true})` | 可以 | 走 shell |

而 `mcpInitConfig` 写出的示例、以及 MCP 生态里几乎所有配置，都是 `"command": "npx"` —— 也就是说 **MCP 面板在 Windows 上对最常见的配置是死的**。

修法：新增 `src/mcp/spawn-command.ts`，像 shell 那样解析——按 `PATH` × `PATHEXT` 找到真实文件，`.cmd`/`.bat` 交给 `cmd.exe` 并逐个参数加引号（`shell:true` 时 Node 是裸拼接，`C:/my dir` 会被拆成两个参数）。非 Windows 与已是绝对路径/带扩展名的情况原样透传，**现有可用配置零回归**。解析用的是**子进程的 PATH**（`env.PATH` 可能覆盖），不是我们自己的。

测试三层：
- `tests/pure.test.ts` +8 组：解析规则、`.cmd`/`.exe` 分流、不可解析时保持 ENOENT、引号规则（空串、空格、内嵌引号、`&|<>`）。
- `scripts/verify-mcp.ts` +3 条：造一个 `mcpfixture.cmd` 垫片放在临时目录、挂到该 server 的 `env.PATH` 上，断言能连上、能列工具、能调用。故意把 `planMcpSpawn` 换成直通后报 `spawn mcpfixture ENOENT` FAIL，还原后 15/15。
- 打包 exe 对真实 server：连接成功、14 个工具、`list_directory` / `read_file` / `write_file` 全部往返正常。

### 握手预算改成每 server 可配

上面那句「12 秒硬编码」是本轮唯一没当场修的：首次 `npx` 要下载整包，冷启动很容易超时并报成 `initialize timed out`——读起来像 server 坏了。现在 `mcp.json` 的每个 server 可以写 `timeoutMs`：

```json
{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "timeoutMs": 60000 } } }
```

- 作用于握手（`initialize` + `tools/list`）和 `tools/call`；单次调用传的 `timeoutMs` 优先。
- 钳到 `[1000, 600000]`：`NaN` / 非数字 / 布尔 / 数组一律当作「没写」回退默认（`setTimeout(NaN)` 会立刻触发，一个笔误就能让所有连接瞬间失败）；低于 1000 抬到 1000，超过 10 分钟压到 10 分钟。
- 默认值不变：握手 12 秒、调用 30 秒，所以现有配置行为完全不动。

测试：`tests/pure.test.ts` +5 组（共 **57**）；`scripts/verify-mcp.ts` +6 条（共 **21**）——一个「initialize 迟 2 秒才答」的 fixture，配三档预算：8000 正常连上、1000 在 1026ms 报 `initialize timed out` 并落成 error 卡片、50 被钳到 1000（错误信息里就是 `after 1000ms`，证明钳制生效而不是「立刻失败」）。

### 新增套件：打包 exe 里的 MCP 面板

`verify-mcp` 驱动的是 `McpManager`，覆盖协议但不覆盖用户真正走的路：`mcp.json` → exe → 侧边栏。新增 `scripts/verify-mcp-exe.ts`（`Package · MCP client in the packaged exe`，30 条，约 11 秒），用面板同一套 WebSocket 消息打打包好的 exe，配置里一次放齐五种卡片状态：

| 条目 | 期望 |
|---|---|
| `demo` | 握手 → 4 个工具 → echo/add 往返 → 工具级错误 `ok:false` → 单次 `timeoutMs` 覆盖生效 |
| `broken` | 启动即退，卡片要带退出码和 stderr |
| `picky` | `disabled: true`，连接被拒 |
| `slowGood` | `initialize` 迟 2 秒，预算 8000 → 连上（且确实等了 >1.5s） |
| `slowBad` | 同一 server，预算 1000 → 在预算处失败 |

外加一次空配置启动验证 `mcpInitConfig`。服务端全是运行时写出的 `.cjs` fixture，不需要网络、不需要真实 MCP 包。

写这个套件时踩到一个失败模式：第一版把每次等待都设成 30–40 秒，偶发一次收不到帧之后，后面 14 条检查全部超时，汇总看起来像「14 处坏了」，实际是「一次卡住」。现在每次等待空手而归时会顺手问一次 `/health`，进程没了就打印日志尾巴并抛错，汇总里只有一条 `ABORTED: ...`。

### 日志系统：补上「落盘」，并让丢日志这件事不再无声

排查上面那个安装问题时，最难受的一点是**没有日志可看**。翻完代码，原因很直接：

- 内核日志只走 `ConsoleTransport`，而桌面版是 **GUI 子系统 exe，没有控制台**——等于写进了虚空；
- 唯一的持久化是 SQLite 温层，而它在 profile 目录只读时会直接报 `attempt to write a readonly database`，然后退回纯内存；
- `desktop.log` 只记启动事件，而且**超过 256 KiB 就删掉重来**——最该看的「出事前几条」永远第一个消失；
- 更糟的是它的写入失败被 `catch {}` 完全吞掉。那次排查时它一直是空的，却没有任何地方说「写不进去」。

四处都改了：

| 改动 | 之前 | 现在 |
|---|---|---|
| 内核日志落盘 | 无（GUI 下等于丢弃） | 新增 `src/log/transports/FileTransport.ts`：NDJSON，一行一条，首行是进程头（版本/平台/启动时间/pid）。默认 `logs/app.log`，`NOLANGUAGE_LOG_FILE=0` 可关 |
| 轮转 | 超限即删 | 按大小轮转 `.1/.2/.3` 保留 3 代；**写入前**判断，保证 `app.log` 始终存在（否则崩溃时最后一批记录只躺在 `.1` 里） |
| 面板丢日志 | `fresh.slice(-300)` 后游标照走，**永久静默丢弃** | 帧里带 `dropped: n`，面板渲染一行「… N 条日志已跳过」，不再让时间线看起来连续 |
| `desktop.log` | 删除重来 + 失败静默 | 轮转到 `.1`；首次写失败向 stderr 报一次（之后不再刷屏） |

`FileTransport` 的三条边界：单行超长时**截断消息再重新序列化**（直接切 JSON 字符串会产出解析不了的行）；队列上限 5000 条，溢出计数而不是无限增长；写入失败只记账（`stats()`）从不抛出——日志系统不该有能力弄挂应用。

测试：`tests/pure.test.ts` +10 组（共 **67**）覆盖 `sliceDigest` 与 `FileTransport`（头部行、级别过滤、轮转代数、截断后仍是合法 JSON、路径不可写时不抛且记账、队列上限）；`smoke-exe` +3 条（共 **27**）在**打包 exe** 上断言日志文件存在、首行是进程头、每条都是单行 JSON。

实测：打包后的 exe 启动 16 秒写出 25 行，含 `INFO`/`WARN`/`DEBUG`，组件覆盖 `kernel`、`lsp.nolanguage-py`、`extension.demo.hello`，WARN 带结构化字段（`method`、`durationMs`、`thresholdMs`）。

### `npm run install:app`：把「别在仓库里双击」变成一条命令

上一轮排查留下的那条隐性规则——安装包从 checkout 里运行会 90 秒不产出文件，复制到别处就 1–3 秒——现在被编码进 `installer/install-app.ps1`：

```bash
npm run install:app              # 装到上次的目录（读注册表 InstallLocation）
npm run install:app -- -Dir D://X # 指定目录
npm run install:app -- -DryRun    # 只打印计划
```

内部就是那条规则：复制到临时目录 → `/S` 静默安装 → 校验。校验不只看文件在不在：

- 目标 exe **> 10 MB**（安装器先返回、后落盘，零字节占位不算成功）；
- 注册表 `InstallLocation` **指向目标**（装到别处，下次升级就找不到）；
- `uninstall.exe` 与开始菜单快捷方式存在（缺一个等于装了个卸不掉的东西）；
- 装完的 exe **真的起得来**：用 7391 端口（不是 7310，避免被已运行实例代答）探 `/health`，通过后关掉自己启动的进程，不留残留。

实测 13 秒完成（payload 落盘 7 秒），`health: status=ok version=0.7.23-workspace`，退出后无残留进程、无临时目录。`installer/README.md` 同步写清了这条规则和两份日志文件的位置。

### 日志：内核起来之前也要有记录

上一轮补的 `logs/app.log` 有个前提——**内核得先起来**。可偏偏最要命的一类失败发生在它之前：embedded 资源解压。那次 `EPERM ... extension.json` 只留下 stderr 上的一段栈，`app.log` 根本没被创建，`desktop.log` 也没有，因为它的崩溃钩子装得比失败点还晚。

新增 `src/util/bootLog.ts`（`logs/boot.log`）：

- 进程头（版本 / 平台 / 启动时间 / pid / argv）+ 里程碑 `boot` → `server-starting` → `server-ready`，所以只有一行的 `boot.log` 也能告诉你启动走到哪一步；
- 失败记录 `server-start-failed` / `uncaught`，带 `asset`、`code`、`errno`、`syscall`、`path`——"operation not permitted" 本身没有信息量，是哪次写、写到哪才是；
- 用 `uncaughtExceptionMonitor` 而不是 `uncaughtException`：只观察，不改变 Node 的崩溃语义（普通监听器会让坏掉的进程继续活着）；
- 单独一个文件而不是并进 `app.log`：`app.log` 承诺"首行是进程头"，冒烟测试就在断言这一条，先写 boot 行会破坏每个读取方的前提。

**层级问题**：`assets` 是第 0 层，`log` 是第 2 层，`assets → log` 被 `verify:arch` 判为向上依赖（先试 `log`，再试同层的 `util`，都被拒）。最后的解法是不引入依赖——`materializeAssets` 只把出错的 asset 名挂到 error 上（`EmbeddedAssetError`），由第 13 层的 `desktop/main.ts` 记下来。

### 文件日志默认降到 INFO

`NOLANGUAGE_LOG_LEVEL` 控制**文件**保留的级别，默认 `INFO`；面板与环形缓冲仍是 `TRACE`，互不影响。桌面跑几天的话，全量 TRACE 会把轮转文件塞满 `Command xxx started/done`，真正要看的那行被埋掉。

实测同一个 exe：默认 `22 INFO + 1 WARN`（零 TRACE），`NOLANGUAGE_LOG_LEVEL=debug` 多出 DEBUG 行；刻意触发 EPERM 时 `boot.log` 记下 `asset: extensions/examples/faulty/extension.json` 与完整 errno。

### 顺手：`.tmp` 从 5.5 GB 清到 1 MB

冒烟沙箱每次复制一份 93 MB 的 exe，收尾是 best-effort，进程被杀就整目录留下——几十次运行攒到 5.5 GB。现在 `smoke-exe.ts` 启动时清扫**超过一小时**的 `smoke-*` 兄弟目录（只碰自己命名的、且足够旧的，不会干扰并发运行）。

测试：`tests/pure.test.ts` +5 组（共 **72**）覆盖 boot sink（未配置时静默、`0`/`off` 关闭、头部行、错误字段、目标不可写不抛）。

### 语言一致性门禁：`verify:langparity`

「所有语言用同一套框架」这句话，光靠文档守不住。新门禁 `scripts/verify-langparity.ts`（接入 `verify-all`，49 套件）把它变成可失败的四条：

| 检查 | 结果 |
|---|---|
| 每个插件都声明同一组核心字段（id/displayName/version/apiVersion/publisher/description/order/trust） | ✅ 8 × 5 |
| 声明了 `lsp`/`run`/`debug`/`profiler`/`file` 块，就带齐该块的必填子字段 | ✅ 5 个块 |
| **核心层不得按语言名比较**（`language === 'python'` / `case 'go':`） | ✅ 0 处 |
| 裸语言字面量按文件预算卡住（只许降不许升） | ✅ 49 处，预算内 |

写门禁时抓出两处真硬编码并修掉：

1. `src/panel/handlers/perf.ts`：`if (language !== 'python')` —— 覆盖率被一个语言名锁死。改成读 manifest 的 **`run.coverage`**（新增字段，Python 声明 `true`），第二个语言想有覆盖率只需在自己 manifest 里打开。
2. `src/langs/interpreters.ts`：`` `${languageId === 'python' ? 'Python ' : ''}` `` —— 解释器标签硬拼语言名。列表本来就按语言分组，前缀是冗余，去掉。

**Ratchet 而不是一刀切**：现有 49 处裸字面量（`samples.ts` 19 处演示内容、`FsService.ts` 11 处扩展名映射、`LspClient.ts` 6 处 Python 专用发现函数…）都记了预算与理由，只允许下降。新写一个字面量立刻失败。

门禁本身做了注入验证：往 `coverage.ts` 里塞一行 `language === 'python'` → 两条检查同时 FAIL（比较 + 预算），还原后 5/5 通过。

同时修了门禁自己的一个 bug：CRLF 下按 `
` 分行会留下 `
`，而 `$` 不能匹配 `
` 之前，导致注释剥离静默失效、文档注释被当成代码报错。

**能力覆盖矩阵**（报告，不强制——这是产品决策）：`lsp` 4/5（zh-cn 是本地化包）、`run` 3/5（markdown 无运行时）、`debug` 2/5、`profiler` 2/5（仅 python/go）。
### 内置兜底服务通用化：插件声明命令，引擎不再认识语言

`bundledFallback` 原来是字面量 `"stub"`，引擎用 `fallbackServerSpec()` 解析——那个函数写死了 Python 的解释器、语言 id 和脚本路径。注释写着「命名能力，不是语言判断」，实现却是一个绕了弯的语言判断：**任何语言声明 `"stub"` 都会拿到 Python 的服务**。

现在插件自己声明命令：

```jsonc
"bundledFallback": {
  "languageId": "python",
  "serverName": "nolanguage-py",
  "command": ["{toolchain}", "-u", "{embedded:pyrightServer.py}"],
  "sourceDir": "python"
}
```

新模块 `src/lsp/bundledFallback.ts` 只做两件事：展开 `{toolchain}` 与 `{embedded:<key>}`（打包读内嵌资源，源码读 `src/<sourceDir>/<key>`），以及解析不出来时返回 `undefined` 让上层落到 `degradedNote`。**它不知道调用方是哪个语言。**

连带清掉的：

- `WorkspaceService` 里的 `stubInterpreter()`（`process.env.PYTHON_BIN ?? 'python'`）—— 该文件的语言字面量从 1 降到 **0**，总预算 49 → **48**。
- manifest 校验拒绝旧的字符串形式，并要求 `command` 是非空字符串数组。

同时修了 ratchet 的一个反向惩罚：原来连**注释里**的语言名也计数（新文件在 JSDoc 里举例 `"python"` 就被判超预算）。注释不构成耦合，现在先剥离注释再数。

测试 +6 组（共 **78**）：`{toolchain}`/`{embedded:}` 展开、缺 toolchain 拒绝、资源不存在拒绝、id 默认值、纯命令透传、畸形声明不抛。

**踩到一个坑**：`verify:smoke` 用 `dist/` 里现成的 exe，**不会自动重建**。改完 `src/` 或 `builtin/` 直接跑冒烟会得到「Python LSP 起不来」的假回归——重建后即 PASS（`nolanguage-py`）。
### `src/lsp` 彻底语言无关：Python 的发现逻辑搬回 `src/python`

上一轮把 `bundledFallback` 从引擎搬进 manifest 后，`src/lsp` 里还剩最后一处语言知识：`discoverPythonServer` / `canImportModule` / `fallbackServerSpec` —— 它们写死 Python 的可执行名、Python 的模块名、Python 的脚本路径，却住在通用客户端里。

搬到新模块 **`src/python/serverDiscovery.ts`**（9 层，向 `lsp`(6) 依赖是向下）。顺带简化的地方：`fallbackServerPath()` 原来写 `new URL('../python/pyrightServer.py', import.meta.url)`，现在模块就在 `src/python/` 里，改成 `./pyrightServer.py`。

**同时删掉两个隐式 Python 默认值**——它们比搬移本身更危险：

| 位置 | 原来 | 现在 |
|---|---|---|
| `LspClientOptions.launch` | 可选，注释写「否则自动检测」 | **必填**。原来缺省时会 `await discoverPythonServer()`，也就是说**任何语言忘了传 launch，都会静默起一个 Python 服务** |
| 构造器 | `opts.launch?.languageId ?? 'python'` | `opts.launch.languageId` |

四个构造点本来就都显式传了 `launch`，所以这是一次纯收紧。

效果：`src/lsp/LspClient.ts` 的语言字面量 **6 → 1**，剩下的那一个是 `contentFormat: ['markdown', 'plaintext']`——LSP 的 MIME 类型，不是语言判断。ratchet 总预算 48 → **43**。

验证覆盖：`verify:stage3`（源码模式跑真 LSP）与打包冒烟（`python LSP is ready — nolanguage-py`）都通过，说明搬移在两种模式下都成立。
### 解释器发现：插件声明 `run.interpreters`，引擎表只作兜底

`INTERPRETER_SPECS` 是引擎里的硬编码表（8 个字段 × 3 种语言）。它和 manifest 的 `run.discovery` **不是**重复——一个答「该跑哪个二进制」，一个答「机器上装了哪些 SDK/环境」（venv、conda、pyenv/nvm/volta + 版本探测）。但它是唯一还留在代码里的能力块，后果是**第三方语言插件的 SDK 选择器永远是空的**。

按「声明 + 兜底」改造（沿用 `bundledFallback` 的范式）：

- manifest 新增 `run.interpreters`，**每个字段都可选**——只做 PATH 发现的插件写个 `exeNames` 就够了；`normalizeInterpreterSpec()` 负责补默认值，循环永远拿到完整 spec。
- `discoverInterpreters()` 取 `opts.spec ?? INTERPRETER_SPECS[languageId]`：**声明优先、表兜底**。测试锁定了「声明是权威的，不与表合并」——给 python 声明一个空 spec，`.venv` 就不再被发现。
- 三个内置插件（python/js/go）把数据搬进各自 manifest。

顺手修掉的三处问题：

1. **循环里最后一处硬编码**：`sdk.includes(\`python ${c.version}\`)`（PyCharm 把 SDK 命名成 "Python 3.11.9"）。改成 spec 的 `sdkPrefix` 字段。
2. **大小写 bug**：`sdk` 先 `toLowerCase()`，而前缀原样拼进去——`"Kotlin 1.9.0"` 永远匹配不上 `"kotlin 1.9.0"`。旧代码能跑是因为 `python` 恰好是小写。新测试一上来就抓到了。
3. **空 marker 的隐患**：`join(envDir, '')` 就是目录本身，`existsSync` 恒真——插件只写 `envDirs` 不写 `marker`，会把任意列出的目录当成环境。现在没有 marker 就跳过整步。

门禁 `verify:langparity` 补两条（6 项检查）：

- **每个可运行插件必须声明 `run.interpreters`**——内置插件没有资格依赖兜底表，否则加语言仍要改 TS。
- **`src/langs` 纳入字面量统计**。之前只统计 `src/panel` + `src/lsp`，而解释器表和**第三份**扩展名映射（`ideaImport.ts`，9 处）正好住在 `src/langs` 里，属于规则空档。预算 43 → **55**（新增 `interpreters.ts` 3 处兜底表键 + `ideaImport.ts` 9 处扩展名映射，都记了成因）。

测试 +5 组（共 **83**）：未知语言靠声明即可发现、声明替换而非合并兜底表、`sdkPrefix` 匹配、无 marker 不误判、无声明时表仍可用。
### 扩展名映射收成一份：`langs/extensionIndex.ts`

「这个文件是什么语言」原来有**五份**答案，而且互相矛盾：

| 位置 | `.ts` 的答案 |
|---|---|
| `FsService.EXT_LANGUAGE` | `typescript` |
| `ideaImport.EXT_LANGUAGE` | `javascript` |
| `debugtool.languageOf` | 不认 |
| 客户端 `EXT_LANG` | `typescript`（连接前兜底，catalog 会覆盖） |
| `manifest.file.extensions` | 无插件认领 |

`.ts` 的分歧是症状：**`typescript` 这个 id 在产品里不存在**——没有插件、没有 manifest、没有服务、没有运行时。资源管理器把它标成 `typescript`（什么都干不了），同一个文件的运行配置却叫 `javascript`。

现在统一到 `src/langs/extensionIndex.ts`，三层优先级：

1. **manifest 的 `file.extensions`**（注册表扫描后注入，最高）
2. **`BUILTIN_EXTENSION_DEFAULTS`**——给没有注册表的进程用（`NDebug.exe` 独立运行），也是面板首次扫描前的值
3. **`NO_PLUGIN`**——只高亮不运行的语言（json/yaml/shell/…）

`.ts/.tsx` 归到 `javascript`：这是唯一存在的 JS 家族插件，它的语言服务（tsserver）本来就处理 TypeScript，所以 **`.ts` 现在反而有补全和诊断了**。

门禁加一条（7 项）：**内置默认值必须与认领同一扩展名的 manifest 一致**——默认值本质是 manifest 的副本，所以要被校验而不是被信任。

收掉的重复：`FsService` 11 处 → 0，`ideaImport` 9 处 → 0，新文件 13 处（唯一的表）。总预算 55 → **48**。

`verify-explorer` 里 `['app.ts', 'typescript']` 的断言随之改成 `javascript`，并在注释里写明这是有意变更。

`debugtool.languageOf` **保留**自己的三分支：它回答的不是「这是什么语言」，而是「我能不能观测它」（只支持 python/javascript/go），属于能力矩阵而非语言身份表。
### 启动优化：先量再改，三条里只有一条成立

上一版报告给了三个优化目标。加打点实测后，**两个的前提是错的**：

| 上一版说法 | 实测 | 处置 |
|---|---|---|
| 744 ms 模块图加载 | **16 ms** | 不做。打包是单个 1.6 MB CJS，动态 `import()` 不省解析 |
| gitStatus 77 ms「每次都要等」 | 客户端只在开面板/提交后/手动刷新时请求；77 ms 是 **git 进程启动地板**（`git rev-parse` 空目录也要 134 ms） | 不做。加缓存只会引入状态过期风险 |
| 扩展宿主 226 ms | 实测真实成本 **76 ms** | **已做** |

`demo.hello` 从 `onStartup` 改为按命令激活（`onCommand:demo.hello.greet` / `demo.hello.fib`）。

**冷启动 1022 ms → 946 ms（-7.4%）**，三次取中位；其余阶段完全持平，说明省下的就是这一项。

打包冒烟 27/27 通过——`extension host is ready` 仍然成立，因为冒烟先跑了 `fib` 再断言状态，恰好验证了懒激活路径。

### 顺带加了启动阶段打点

`boot.log` 现在有 `server-module-loaded` / `kernel-constructed` / `kernel-started` 三个点，配合原有的 `server-starting` / `server-ready` 可以拆出四段：

| 阶段 | 中位 | 归因 |
|---|---|---|
| SEA 引导 | 33 ms | — |
| 模块图 | **16 ms** | 单 bundle，已内联 |
| `kernel.start()` | **320 ms** | `correlation.prime()`（spawn git）+ SQLite 打开 + 三条 spine |
| workspace 初始化 | **575 ms** | LSP eager 277 ms + 扩展（已省）+ slots/demo/baseline |

没有这三个点，「744 ms 是模块加载」这个错误结论会一直留在报告里。

### 重新排序：性能代价越小越该先做

按「实现后增加多少运行时开销」重排，结论和「按体验收益」并不一致：

- **打包四种语言服务**：体验收益第一，性能代价也第一（+630 MB、gopls 冷诊断 20 s）。
- **五个导航能力**：体验收益同样靠前，性能代价**几乎为零**（复用已有 LSP 连接，只有全库符号索引有一次性成本）。

所以理性顺序是**先做五个导航能力**——高收益、零常驻代价；打包语言服务则应该按语言按需启动，而不是全量常驻。

### 顺手修掉一个会制造假绿的门禁漏洞

给 `server.ts` 加了 `import { bootLog }` 之后，导入数从 474 变成 475。本地 `verify:docs` **通过了**，CI 却失败——因为 `verify:docs` 比对的是 `.tmp/arch-summary.json` 这个**缓存**，而我在改完源码后没有重跑 `verify:arch`，缓存里还是 474。

现在 `verify:docs` 会先检查缓存是否比 `src/` 新，过期就直接失败并提示「先跑 verify:arch」。注入验证过：`touch src/version.ts` → FAIL，重跑 arch → PASS。

这个漏洞的危险之处不是它错了，而是它**绿得毫无征兆**——只有 CI 才发现。
### 五个导航能力：协议层与客户端完成，内置 Python 服务也实现了

清单里最贵的一项（高收益、零常驻代价）落地了。

**协议与客户端**：

- `src/lsp/navigation.ts`：五个能力的结果类型与归一化。LSP 的返回形状很随意——`definition` 可能是 `Location | Location[] | LocationLink[] | null`，`rename` 可能是 `changes` 或 `documentChanges`——分支只写一次。
- `LspClient` 加 `definition` / `references` / `renameSymbol` / `codeActions` / `workspaceSymbols`，统一走一个 `nav()`：**服务端没声明 → `unsupported`；服务端返回 -32601 → `unsupported`；真错误才抛**。为此给 JSON-RPC 错误补了 `rpcCode` 字段，不再靠字符串匹配。
- `PanelHub` 五个结果帧，每个都带 `unsupported?: string`。
- `src/panel/handlers/navigation.ts`：五个处理器，`references` 与 `workspaceSymbol` 超上限时带 `truncated`。

**关键区分**：「没有结果」和「这个服务不会」必须分开。合并成空数组的话，用户看到的是「没找到」，而真相是「没装 gopls」。

**内置 Python 服务补齐五个方法**（`ast`，同文件范围）：跳转定义、查找引用、符号重命名（非法标识符直接拒绝，而不是产出一个语法坏掉的文件）、快速修复（未使用 import）、全局符号。所以**不装 pyright 也能用**。

端到端实测（打包 exe → WS → 服务端 → LSP 客户端 → python 服务）：

| 能力 | 结果 |
|---|---|
| 跳转定义 | `add(...)` → 1 处，line 0 col 4 |
| 查找引用 | 2 处（定义 + 调用） |
| 符号重命名 | 2 处编辑；`2bad` 被拒并给出理由 |
| 快速修复 | `Remove unused import 'os'` |
| 全局符号 | 查询 `ad` → `add:function` |

**一个设计修正**：清单原本计划在 manifest 里加 `lsp.capabilities` 作为声明。实现时改成读服务端 `initialize` 返回的 `*Provider` 字段——那才是权威来源；manifest 再写一份只会制造第二处真相，而清理这类重复正是这一周在做的事。

**尚未做**：客户端按键与结果面板（协议已通，用户还按不出来）；gopls / tsserver / marksman 装上即生效，因为请求已经是通用的。

测试 +5 组（共 **94**）：四种 definition 返回形状、两种 workspace-edit 方言、command-only action、符号扁平化、以及「未声明能力 ≠ 空结果」。
### 客户端接上五个导航按键

协议通了不等于能用——用户得按得出来。

`src/ui/client/68-nav.js`（新分片）：

| 键 | 动作 |
|---|---|
| `Ctrl+B` / `Ctrl+单击` | 跳转定义（多处时列出选择） |
| `Alt+F7` | 查找引用（浮层列表，带 `truncated` 提示） |
| `Shift+F6` | 符号重命名（编辑器内；项目树里仍是文件重命名） |
| `Alt+Enter` | 快速修复 |
| `Ctrl+T` | 全局符号搜索（先问查询词） |

结果用**键盘可导航的浮层**（↑↓/Enter/Esc），DOM 在 JS 里按需创建——HTML 壳是带反引号守卫的模板字符串，这种只在需要时出现的东西不该写成静态标记。

**两个坑，都值得记**：

1. **分片位置**：一开始把 `75-nav.js` 放在 `70-shell.js` 之后，而 `70-shell.js` 的最后一行关闭了主 IIFE。于是 `navDefinition` 落在了全局作用域，`30-panels.js` 的按键处理器里看不见它——表现是「按了没反应，也不报错」（`preventDefault` 已执行，随后 `ReferenceError` 被 jsdom 吞掉）。改名为 `68-nav.js` 放在 IIFE 内即解决。
2. **分片不能有反引号**：注释里的 `` `code` `` 风格也会让 `verify-pycharm` 的「no fragment contains a backtick」失败。已全部改成普通引号。

`verify-ui-dom` 加 7 条断言，真派发键盘事件并检查发出的帧：

- `Ctrl+B` / `Alt+F7` / `Shift+F6` / `Alt+Enter` / `Ctrl+T` 各自发出正确的请求；
- 收到 `definitionResult` 后光标真的移到目标位置（`Ln 5, Col 5`）；
- `unsupported` 弹对话框，**不是**空列表。

写这条测试时还踩了一次「测试错了而不是代码错了」：我给的坐标落在样例文件的**空行**上，字符偏移溢出到下一行，光标停在 `Ln 5, Col 3`。代码是对的，断言选了无意义的坐标。

分片数从 9 变 10，`verify-pycharm` 的区间随之从 6–9 放宽到 6–10——那条门禁的本意是防止退回「一个 4200 行的模板字面量」，不是精确卡在 9。








### 语言一致性门禁：`verify:langparity`

「所有语言用同一套框架」这句话，光靠文档守不住。新门禁 `scripts/verify-langparity.ts`（接入 `verify-all`，49 套件）把它变成可失败的四条：

| 检查 | 结果 |
|---|---|
| 每个插件都声明同一组核心字段（id/displayName/version/apiVersion/publisher/description/order/trust） | ✅ 8 × 5 |
| 声明了 `lsp`/`run`/`debug`/`profiler`/`file` 块，就带齐该块的必填子字段 | ✅ 5 个块 |
| **核心层不得按语言名比较**（`language === 'python'` / `case 'go':`） | ✅ 0 处 |
| 裸语言字面量按文件预算卡住（只许降不许升） | ✅ 49 处，预算内 |

写门禁时抓出两处真硬编码并修掉：

1. `src/panel/handlers/perf.ts`：`if (language !== 'python')` —— 覆盖率被一个语言名锁死。改成读 manifest 的 **`run.coverage`**（新增字段，Python 声明 `true`），第二个语言想有覆盖率只需在自己 manifest 里打开。
2. `src/langs/interpreters.ts`：`` `${languageId === 'python' ? 'Python ' : ''}` `` —— 解释器标签硬拼语言名。列表本来就按语言分组，前缀是冗余，去掉。

**Ratchet 而不是一刀切**：现有 49 处裸字面量（`samples.ts` 19 处演示内容、`FsService.ts` 11 处扩展名映射、`LspClient.ts` 6 处 Python 专用发现函数…）都记了预算与理由，只允许下降。新写一个字面量立刻失败。

门禁本身做了注入验证：往 `coverage.ts` 里塞一行 `language === 'python'` → 两条检查同时 FAIL（比较 + 预算），还原后 5/5 通过。

同时修了门禁自己的一个 bug：CRLF 下按 `\n` 分行会留下 `\r`，而 `$` 不能匹配 `\r` 之前，导致注释剥离静默失效、文档注释被当成代码报错。

**能力覆盖矩阵**（报告，不强制——这是产品决策）：`lsp` 4/5（zh-cn 是本地化包）、`run` 3/5（markdown 无运行时）、`debug` 2/5、`profiler` 2/5（仅 python/go）。


## 0.7.22 — 2026-11-13

### PyCharm 式的安全标签操作与无缝切换

原先输入后切到另一标签，内存 buffer 只标记 dirty，却没有同步编辑器里的新文本；切回来可能看到旧内容。更危险的是点标签 × 或 `Close All` 会直接删掉 dirty buffer。现在：

- 输入即时更新所属 buffer，标签切走再回来保留最后文本与 dirty 标记；
- `Ctrl+F4` 和 File → Close Tab 都关闭当前标签，与 PyCharm / JetBrains 常见操作一致；
- 关闭未保存标签时显示 **Save / Don't Save / Cancel**，不再无确认地丢编辑内容；
- Save 后等对应 `fsSaved` 确认才关 tab；保存失败会说明原因并保持文件打开；请求带 reqId，避免旧回执清掉新编辑；
- 同一路径并发保存串行，期间再次点 Save 会排队最新文本；如果保存过程中又有新编辑，不会误关标签；
- Close All 只有一个确认框，Save All 等全部 dirty 文件写成功后才一起关闭；任一失败保留所有标签。

新增完整 jsdom 交互回归：跨标签编辑保留、Cancel、Save 确认、保存失败、显式丢弃、连点 Save 排队最新文本、Close All 多文件确认和逐项 ACK。`verify-pycharm` **284 → 304 条**。

### GitHub runner 验证状态

本轮工作区仍没有 Git remote，且没有 GitHub CLI / runner 环境；不能实际触发远端 workflow。`ci:install-smoke` 已在本机新版安装包上通过，不代表 GitHub runner 已通过。

### 验证

- `verify-pycharm`：**304/304**
- `verify-all`：**2116/2116 · 47 suites**
- `npm test`：**38/38 · 2 files**
- `ci:pure`：403/403 · 15 suites
- `verify-exec`：**38/38**
- `verify-arch`：18/18 · 157 files · 451 imports
- `tsc`：src + scripts 均 0

## 0.7.21 — 2026-11-13

### Markdown 预览窗格可调整大小

0.7.20 的 Markdown 预览采用固定 42% 分栏；窄窗或读长文时，编辑区/预览区比例不合适。现在 `.edwrap` 内加入分隔手柄：

- 鼠标 / 触控拖动，宽度限制在 24%–64%；
- 键盘可聚焦，左右方向键调整，Home / End 跳到两端，双击恢复 42%；
- 暗色 / 浅色主题统一跟随 CSS 变量；
- 使用 `aria-role=separator`、方向和数值范围，更新 `aria-valuenow`；
- 用户宽度写入已有 IDE 偏好，并在下次打开时恢复；
- 预览关闭时分隔手柄一起隐藏。

新增 `verify-pycharm` 回归：手柄可访问性、默认比例、键盘调整与持久化、拖动、重载恢复。UI 验证 **275 → 284**。

### GitHub runner 验证状态

用户要求在 GitHub runner 上实测 `ci:install-smoke`。当前工作区没有配置任何 git remote，环境也没有 GitHub CLI；本轮**未触发也未声称通过**远端 workflow。`.github/workflows/ci.yml` 已支持 `workflow_dispatch`，配置 GitHub remote/授权后即可从 push 或手动 dispatch 真实验证。

### 验证

- `verify-pycharm`：**284/284**
- `verify-exec`：**38/38**
- `npm test`：**38/38 · 2 files**
- `ci:pure`：403/403
- `tsc`：src + scripts 均 0

## 0.7.20 — 2026-11-13

### 评估优化：按 session 串行化执行平面

在 0.7.19 的架构、文档、TypeScript 门禁全绿后，检查 `SandboxPool` 的并发行为。发现同一 `sessionId` 的并发请求有两种会破坏状态的竞态：

1. **首次并发**：两个请求都在 `assigned` 里看不到这个 id，各自 spawn 一个 worker；`ready` 后后写入覆盖前写入，先启动的 worker 变成无人管理的孤儿。Python 的 namespace 也被拆成两个互不相见的状态。
2. **已有 session 并发**：第二个请求命中 `WarmWorker.busy`，但 `SandboxPool` 把任何 reject 都当成 worker death，回收进程并从 `assigned` 删除；原请求与会话状态都遭破坏。

同一个队列也覆盖 `reset`：reset 必须等已有 run 完成，排在 reset 之后的 run 才从冷状态开始。不同 session 使用不同队列，仍可并行。超时从 worker 真正开始执行时才计，返回的 `durationMs` 和日志包含排队等待，并记录 `queueWaitMs`。

另补 active-session 的语言归属校验：同一 id 已属于 Python，却被拿去跑 JavaScript/Go 时，**明确拒绝**而不是把源码送到错误语言的 worker。此举防止静默误路由；未来若需要同名跨语言 session，应明确设计复合 key，而不是复用含糊的字符串 id。

### 回归测试

`verify-exec.ts` 新增并发首启（只 spawn 一个 worker）、namespace 顺序可见、同 ID 跨语言拒绝、活动 run 与 reset 排序、reset 后冷启动等检查。执行平面套件 **29 → 38 条**。

### 顺带：Vitest 的 38 个单测曾经一个也没注册

本轮真实运行 `npm test`，Vitest 报两个文件失败、**no tests**。模块顶层确实执行，但从 `vitest` 包导入的 `describe` 创建的 suite 没挂到活动 worker collector。启用 `globals: true`、删掉两个测试文件对 `vitest` API 的直接导入后，38 个用例恢复并通过。这也是一次评估优化：项目不能只看 `verify-all` 的自有套件，必须真的执行独立的单测命令。

### 验证

- `verify-exec`：**38/38**（真 Python / Node / Go 进程）
- `npm test`：**38/38** · 2 files
- `tsc`：src + scripts 均 0
- `verify-arch`：18/18 · 157 files · 451 imports · 零例外
- 完整 `verify-all`：**2087/2087 · 47 套件**

## 0.7.19 — 2026-11-12

### #45 · 执行平面的验证套件 —— 装上就抓到 Python 沙箱从未工作

`src/exec/` 有 932 行（预热池、worker 协议、日志汇聚），**没有任何套件**。新增 `verify-exec.ts`（29 条，真进程）之后第一次运行就红了两处，都是真 bug：

| bug | 后果 |
|---|---|
| Python worker 用了 `contextlib.redirect_stdout`，但**从来没 import `contextlib`** | 重定向从不生效，片段的 `print` 直接写进帧协议的 stdout，把协议打乱 |
| `write_frame` 只写长度头，**从不写 JSON 正文** | 每一次响应都是"头有、身无"；池子读不到正文，只能等到超时 |

叠加效果：**每一次 Python 的 `code.run` / `sandbox.run` 都等到 8 秒超时**，之后整个池子降级（`list()` 变空、后续全部超时）。IDE 的 Run 按钮走 `PythonRunner`（冷启动），所以这条路径从没被人走到 —— 它只对 MCP 的 `code.run` 生效。

修完实测：冷启动 → 热复用 → 抛异常如实返回（`ok:false, exit:1`）→ **worker 存活**、下一次照常 → `reset` 回到冷启动。

套件覆盖：预热复用 / Python 命名空间延续 / 会话隔离 / 超时 / reset / `list()` 的真实计数 / worker 输出落到日志脊（`user-code` + sessionId）/ JS 进程复用但 vm 上下文全新 / 命令总线（`sandbox.run` + `code.run` 别名）/ Go 构建与编译错误（缺工具链时 SKIP）/ worker 源码无相对导入。

### #40 · Markdown 预览窗格 + outline

服务端早就完整（`mdRender` → 净化后的 HTML + headings + stats），**客户端从来没发过这个请求**。现在补上那一半：

- **预览窗格**：编辑区右侧分栏（`.edwrap` 本来就是横向 flex，所以是 `.codewrap` 的兄弟节点，不是新布局）。入口：工具栏按钮、`View → Markdown Preview`、`Alt+P`。
- **outline**：窗格内可折叠的标题列，**同时**接管 Structure 工具窗（`Alt+7`）—— Markdown 没有符号可解析，它的"结构"就是渲染器给出的 heading 列表，两处共用同一份数据。
- 点击任意标题把光标移到该行（`gotoLine` 是 0 基，heading 行号是 1 基）。
- **页面从不解析 Markdown**：请求带 `requestId`，过期响应被丢弃（否则两次渲染重叠时窗格会闪回旧内容）；输入 250ms 防抖。

### 顺带修的两处

- **`verify-pycharm` 的脚手架会启动一个已关闭的页面**：窗口 `close()` 之后，排队的 `onopen` 仍会触发 `bootProject`，而 jsdom 清空 `document` 却不置 `closed`，于是崩在 `document.getElementById`。现在 socket 归属它创建时的页面，页面没了就不再 boot。
- 两处模板字符串里写了反引号（`pycharm-shell.ts`、`pycharm-css.ts`）—— 正是这套代码被拆成 8 个 `.js` 分片之前的老毛病。`verify-pycharm` 的守卫当场地抓住了第三处（在分片注释里）。

### 验证

- `verify-exec`：**29/29**（含 Go 构建）
- `verify-pycharm`：**275/275**（新增 9 条预览断言，走完整闭环：打开 .md → 请求 → 渲染 → outline → 跳行 → 过期丢弃）
- `verify-all`：**47 套件**
- `tsc`：0（src + scripts）

## 0.7.18 — 2026-11-12

### 账本里的例外清零

`architecture.json` 的 `budgetExceptions` 现在是 **`{}`**。没有文件超过 1200 行，没有切片超过 25 个文件——这是第一次。

**`panel` 27 → 21 文件，新切片 `ui`（12 个文件）。** 切法是按职责，不是按行：五个页面 shell、`assets/`（浏览器端 JS）、`ui/`（PyCharm 的 CSS/壳/客户端分片、CodeMirror 资产）、`raw.d.ts` 一起搬走。它们只依赖 `vendor`——页面是纯字符串渲染，不依赖服务器状态。

`pycharm-ui.ts` **故意留在 `panel`**：它要读插件根目录才能把官方插件清单嵌进外壳。第一版把它一起搬进 `ui`，契约立刻报 `ui(1) -> langs(7)`——那条边说明它站错了地方。

**`WorkspaceService.ts` 1229 → 1049 行。** 切法不是搬函数，是把**投影**从状态里分出来：

- 类的职责是**持有** slot、LSP 客户端、活动运行；
- 把 slot 变成状态栏和插件页消费的 JSON，是那个状态的**投影**；
- 投影搬到 `workspace-wire.ts`，接收声明的 `WorkspaceView`（`slots` / `order` / `registry` / `resourceSummary`），类只留四个一行的委托。

形状必须跟着函数走：留在原文件再 import 回来，两个文件就互相 import，R2 会拒。所以 `Slot`、`LanguageStatus`、`LanguageDescriptorWire` 都搬过去，`WorkspaceService` re-export 给老 importer。

### 搬完立刻崩了两个套件，都不是测试太脆

- `codemirror-assets.ts` 的相对路径差一级（`../../vendor` → `../vendor`）。于是 `server → pycharm-ui → codemirror-assets` 整条链在 import 期就死了，`verify-ide` 报的却是 "server did not start"。
- `verify-pycharm` 里有一处**硬编码** `src/panel/ui/client`。它不在 import 图里，**tsc 看不见**，只有跑套件才知道。

第二条是这轮最值得记的：**类型检查覆盖 import 图，覆盖不了字符串里的路径。**

### 顺带

- 文档门禁抓到了两份 live 文档里的旧路径（`语言插件化设计.md`、`docs/添加新语言指南.md`）——这正是它存在的理由。

### 验证

- `verify-arch`：18/18 · `157 files · 451 imports` · 零环 · **零例外**
- `verify-all`：46 套件（含 CI 快门）
- `tsc`：0（src + scripts）

## 0.7.17 — 2026-11-12

### 第一次真正跑 CI：它失败了

`ci.yml` 在仓库里待了六个版本，从没被执行过。这次把它每一步都改成 npm 脚本，于是 `npm run ci:pure` 在本机跑的就是 CI 快门——**第一次跑就挂**。

`npm test` 退出码 1，而且 `tests/` 里两个文件只跑了一个：`pure.test.ts` 的 **29 个用例被静默丢弃**。机制是 vitest 写临时目录失败时不报错，只丢掉那个文件，再把其余的报成通过（退出码非 0 只是因为另有一条未处理错误）。两个 worker 并行收集时抢同一份 SSR 缓存，其中一个写入被拒。

修三处：
- **`scripts/run-tests.mjs`**：把 TMP/TEMP/TMPDIR 钉在仓库内；读 vitest 的 JSON 报告，**报告里的文件数少于磁盘上的就失败**。丢一个文件不是通过一个文件。
- **`fileParallelism: false`**：38 个用例 2 秒跑完，并行省不下时间，却制造了这个竞态。
- **`verify-all` 的空选择守卫**：`--pure` 选不到任何套件时原本打印 `0/0 checks passed` 并返回 0。CI 的快门会"跑了个空"还报绿。

同一条逻辑（跑了个空也算过）现在在三个层级都被堵住：**套件**（0/0 记 EMPTY）、**选择集**（空即失败）、**测试文件**（少一个即失败）。

### `verify-ci`：workflow 也是说法

六条检查（C1–C6）：命令都存在、路径都存在、用 `npm ci` 不用 `npm install`、每个 job 都有真正执行的步骤、`continue-on-error` 的步骤必须叫 "(optional)"、每个 `ci:*` 脚本要么被 workflow 调用要么由它运行的步骤拼成。

C6 的第一版是错的：它扫描整个文件，注释里提到的 `npm run ci:pure` 就让它通过了。注释不执行——只认 `run:` 的值。

顺带把 `ci.yml` 里那句「10 suites」删了：写这句话时是 10 个，现在 14 个。**数字要么被检查，要么不写**——和文档门禁同一条规矩。

### 顺带

- 安装冒烟从 workflow 内联脚本搬到 `installer/smoke-install.ps1`，于是 `npm run ci:install-smoke` 也能在本机跑（它仍会改动机器：注册表、开始菜单）。
- `npm test` 的用例数从 9 变成 38——不是新增，是找回。

### 验证

- `npm run ci:pure`：**403/403 · 15 个纯套件**，退出码 0（第一次真正执行）
- `npm test`：2 个文件 38 用例，连续 3 次稳定
- `verify-ci`：6/6；注入三种违规（不存在的脚本、`npm install`、空 job）全部当场 FAIL
- `verify-all`：46 套件；`tsc` 0

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

### 启动失败时弹窗报错（GUI 程序唯一的报错出口）

`Nolanguage.exe` 是 GUI 子系统，没有控制台。启动抛错时它把错误打到没人挂着的 stderr 上、`process.exit(1)`——从外面看就是**双击没反应**：没窗口、没弹窗、没痕迹。上一轮那个 `%TEMP%` 写不进去的失败就是这么「隐身」的。

新增 `src/desktop/fatalDialog.ts`，接在 `main().catch()` 上：

- 弹窗内容 = 错误消息 + 栈 + **`logs/boot.log` / `logs/app.log` 的尾部**（出事前几行才有用，日志开头是一周前的）；
- 同时把**完整**文本写到 `logs/last-error.txt`（弹窗只显示 1800 字符，文件不截断）；
- 每次尝试记一行到 `logs/fatal-history.log`（`dialog=messagebox pid=…`），「没弹出来」时有据可查；
- 两套机制：先试 WPF 的消息框，失败则回退到 COM 的 `Popup`（前者依赖 PresentationFramework 可加载，受限镜像可能拒绝）；
- 文本用 **base64 内联**传入、不落文件——「刚写不进去的目录」往往就是 appData 本身，靠文件传参等于在最需要它的时候显示空白；
- `CI=1` 或 `NOLANGUAGE_NO_DIALOG=1` 时不弹（无头环境不能留一个没人点的模态框卡住 job），改为写 stderr。

实测（人为制造 `ENOTDIR` 硬失败）：`main().catch` 触发 → `[fatal] ENOTDIR: …` 落到 stderr → `last-error.txt` 写入。

**未能验证的部分**：弹窗的**视觉结果**。我的工具环境里 GUI 子进程不落到可见桌面上（运行期编译 .NET 与 COM 实例化都被安全策略拦），所以窗口有没有真的画出来我无法确认——机制层面（进程被拉起、参数正确）是通的。

测试 +3（共 **101**）：文案包含消息/栈/日志尾、文件保留未截断版本、日志目录不可写时不抛。
### 已知问题

- Tauri 原生窗口在 wry 0.57 + WebView2 143 上启动崩（`msedge.dll`，`SubCode=0x80000003`），且无更新版本可升；0.7 不发布 Tauri 安装包，桌面使用 Edge `--app`。
- 阶段 11 归因引擎、插件市场远程安装 + `trust.signature` 尚未开始。
