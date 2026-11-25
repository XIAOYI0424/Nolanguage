# Nolanguage

多语言开发与执行工作台：微内核（三总线 + 性能/日志双脊柱）+ 面板式 IDE + 插件化语言体系。同一份引擎可以跑在系统浏览器、Edge `--app` 窗口，或作为 Tauri v2 壳的 sidecar。

## 快速开始

```bash
npm ci
npm run build:exe        # → dist/Nolanguage.exe（Node SEA，自带运行时，GUI 子系统）
dist\Nolanguage.exe      # 打开工作台（默认 127.0.0.1:7310）
```

公开的启动形态只有三个，同一个可执行文件：

| 命令 | 行为 |
|---|---|
| `Nolanguage.exe` | 自带服务 + Edge `--app` 原生窗口 |
| `Nolanguage.exe --open-browser` | 自带服务 + 系统默认浏览器 |
| `Nolanguage.exe --no-open` | 只起 HTTP/WebSocket 服务（脚本 / CI / 无头） |

桌面窗口就是应用的生命周期：**关掉窗口即结束后台服务**（语言服务器、worker、SQLite 落盘一并收尾），不会留下无声运行的后台进程。同一端口已有实例时，再双击不会起第二套服务、也不会多开一个窗口；上次崩溃遗留的孤儿窗口会在下次启动时被清掉。

源码模式（开发用）：

```bash
npm run panel            # 同 `nlg web`：起服务并提示地址
npm run ide              # 前台运行面板服务（Ctrl+C 结束）
```

Python 语言插件已随包内置（`builtin/python@1.0.0`），装完即可新建 `.py` 运行；Go / JavaScript / Markdown / Java 同理。Java 内置 Gradle 多模块、Spring Boot、Maven 三套工程模板，`build.gradle` / `pom.xml` 依赖坐标可直接添加并显式拉取。

编辑器内置 **CodeMirror 5.65.21**（vendor 在 `src/vendor/codemirror/`，随页面内联，不走 CDN，也不是 npm 依赖）：语法高亮、括号匹配、自动闭合、当前行、行号、补全弹窗。没有布局引擎的环境（jsdom 测试）会自动回退到原来的 `<textarea>` + 高亮层，所以同一份页面在浏览器 / Edge 窗口 / 测试里都能跑。

## 插件

引擎零硬编码：一门语言由 `manifest.json` 描述，插件装好即生效。内置 `python` / `go` / `javascript` / `markdown` / `java` 在 `builtin/<id>@1.0.0/`，第三方插件装进插件主目录：

| 位置 | 内容 |
|---|---|
| `~/.nolanguage/languages/<id>@<ver>/` | 插件本体（`manifest.json` + 语法 / 运行器 / 查询文件） |
| `~/.nolanguage/data/<id>/` | 插件数据（会话、运行配置），卸载默认保留 |

主目录可用 `NOLANGUAGE_HOME` 或 `--home <dir>` 改写；`LANG_DIR`（`:`/`;` 分隔）可追加只读插件根。

应用自身状态（遥测数据库、WebView2 配置）不在上面这两个目录里，而在 `%LOCALAPPDATA%\Nolanguage`（可用 `NOLANGUAGE_DATA` 覆盖），这样卸载删程序目录时不会被 WebView 锁住的缓存拖住。

### 语言插件命令

两个入口，同一实现（`src/commands/lang.ts`）：安装即校验、迁移先于覆盖、`data/<id>/` 不被复制覆盖。

```bash
Nolanguage.exe lang ls              # 安装包里直接可用：exe 是 Node SEA，自带运行时
nlg lang ls                         # 源码树里用 nlg（Windows: nlg.cmd），命令完全相同
```

安装包用户不需要 Node、不需要源码树：`Nolanguage.exe` 内建了 `lang` 子命令，覆盖下面的全部动词；用 Setup 安装时还会把安装目录写进用户 PATH（并留 receipt，卸载精确还原），新开终端即可直接敲 `nlg`。源码模式额外保留 `npm run lang-install -- …` 这个旧入口。

| 命令 | 行为 |
|---|---|
| `lang ls` | 列出已安装插件（id / 版本 / kind / 启用 / 运行模式 / 扩展名） |
| `lang add <目录\|zip\|tar.gz\|url\|git\|id>` | 安装并启用；`--strict` 在运行时依赖缺失时拒绝安装；远程安装默认要求 `--sha256`，裸 id 从插件索引解析 |
| `lang search [query]` | 从插件索引检索（`--source <url>` 追加索引） |
| `lang on <id>` / `off <id>` | 启用 / 禁用 |
| `lang info <id>` | 单个插件全量信息 |
| `lang deps [id]` | 运行时依赖是否满足 |
| `lang up <id> [source]` | 按记录的来源重装 |
| `lang rm <id> [--drop-data]` | 卸载（默认保留 data，`--drop-data` 一并删除） |

```bash
Nolanguage.exe lang add ./examples/cpp@1.0.0
Nolanguage.exe lang add https://example.org/cpp.zip --sha256 <64位hex>
Nolanguage.exe lang add https://github.com/someone/nolang-rust.git
Nolanguage.exe lang search lsp
Nolanguage.exe lang ls
```

`http(s)` 下载默认要求可校验的 SHA-256：索引里的条目没有 hash 或你直接给 URL 时，安装会被拒绝并提示
`--sha256 <hex>`。只有在你明确接受风险时（内部镜像、一次性 fork）才加 `--allow-unverified`；
git URL 和本地目录不是下载物，不受这条约束。zip/tar 解压还有条目数、单条目与总展开字节上限。

旧的 `lang-install` 脚本仍然可用，与上表共享同一套保证：

```bash
npm run lang-install -- install ./examples/cpp@1.0.0
npm run lang-install -- list
npm run lang-install -- enable python
npm run lang-install -- uninstall cpp
```

装完也可在 `/plugins`（=`/languages`）页查看，并用输入框按目录安装、点按钮启用/禁用/卸载；运行中的 IDE 持有自己的视图，命令行装完需重启或在页面刷新。

#### `--dump-plugins`：看清插件从哪来

```bash
Nolanguage.exe --dump-plugins
```

按层打印，每项给出插件目录与 run/LSP 模式。同一个 id 出现在多个层时，落选的那份标 `(未选中)`，并在「遮蔽」段单列胜出者。规则与 `LanguageRegistry.scan()` 完全一致：**版本高者胜；同版本按扫描顺序（project → builtin → user → cli → system）先到先得**。该命令不启动服务、不写配置，可放心用于排障与 CI。

#### 层（layer）：插件从哪来

| 层 | 目录 | 可卸载 |
|---|---|---|
| `project` | `<当前工作区>/.nolanguage/languages` | 是 |
| `builtin` | `<home>/builtin`、仓库或内嵌的 `builtin/` | 否（只能禁用） |
| `user` | `~/.nolanguage/languages` | 是 |
| `cli` | `LANG_DIR` | 否（只能禁用） |
| `system` | `%PROGRAMDATA%\Nolanguage\languages` | 是 |

「同版本先扫描的层胜」是刻意的：官方插件不应被一份同版本的旧副本顶掉。要强制改某条配置，用下面的覆盖层，而不是靠层级打架。

层在三个地方可见：`--dump-plugins` 按层分组、`lang ls` 的 `LAYER` 列、以及面板 `/plugins` 每张卡片上的层徽章（`project` 层高亮）。

#### 覆盖层：改配置，不改插件本体

`<home>/overrides/<id>.json` —— 每个插件一个文件，在 manifest 读取后合并：

```json
{
  "lsp": { "command": ["rust-analyzer", "--log-file", "D:\\tmp\\ra.log"] },
  "run": { "timeoutMs": 30000 }
}
```

- 对象递归合并，数组**整体替换**（不做下标合并），`null` 表示删掉该键、交还给 manifest 默认值；
- `id` / `version` 不可覆盖（否则会与 `data/<id>/` 失联）；
- 合并结果若校验失败，该覆盖被忽略并在 `--dump-plugins` / `lang info` 里报出来 —— 一个笔误不该让语言消失；
- 对内置插件同样生效：**本体只读，配置可覆盖**，升级时覆盖文件不受影响；
- `--dump-plugins` 的「覆盖层」段列出实际改动的字段；文件里写了 manifest 已不存在的键，会标成「过期键」；
- 面板 `/plugins` 里该插件带 `override` 徽章，卡片下列出被覆盖的字段与过期键，被拒绝的覆盖写进右侧事件流；同 id 的落选副本在右侧 `Shadowed copies` 里单独列出（胜出层 / 版本 / 路径）。

### 扩展插件

`extension.json` 形式的 JS 扩展由宿主子进程加载：`EXT_DIR`（`:`/`;` 分隔）追加扫描目录，另外自动扫描随包示例与工作目录下的 `extensions/`；打包版从可执行文件内解包到临时目录。`/extensions` 页可看激活与崩溃事件，示例见 `src/extensions/examples/{hello,faulty}`。

## 验证

```bash
npm run ci:pure          # CI 快门：typecheck + 单测 + 纯逻辑套件（约 15 秒）
npm run verify           # 58 套件（真进程，含打包 exe smoke + 打包 exe 的 MCP 面板 + 语言一致性门禁 + 池化语言服务管理器）；断言总数以本次输出为准
npm test                 # vitest 单测（套件与用例数由本次输出给出；丢了文件会失败）
npm run typecheck        # tsc --noEmit，0 错误
npm run verify:sidecar   # 校验 dist 与 Tauri sidecar 的 sha256 一致
npm run verify:ui-live   # 可选：真浏览器（headless Edge + CDP）跑编辑器与导航按键；缺 Edge 则 SKIP
```

`verify:ui-live` **不在** `verify` 的 58 套里：它需要 Edge、一个空闲端口和打包好的 exe，把无头浏览器设为必过项在 CI runner 上只会带来抖动。改动编辑器、键位或导航分片之后手动跑一次——jsdom 看不到 CodeMirror 拥有文档、真实焦点、真实按键这些最容易悄悄坏掉的部分。

几条门禁值得单独说明，因为它们守的是"看起来有、实际不生效"这类缺陷：

| 门禁 | 守什么 |
|---|---|
| `verify:protocol` | 每条消息 kind 在引擎 `switch` 和页面 `handle(m)` 里都要有分支；漏接一端就报 `file:line` |
| `verify:client` | 页面片段不能有反引号或 `${`，不能被执行字符串，不能重名声明，不能漏注册 |
| `verify:perf` | 首页体积、冷启动、开机外网请求三条预算（本机实测：1.19 MB 原始 / 311 KB gzip / 冷启动约 0.8 s / 开机外网请求 0） |
| `verify:panel-auth` | 非回环监听必须带 token；401、cookie、三种携带方式逐条验证 |
| `verify:langsource` | 插件来源的 zip/tar 防逃逸、解压上限、无 hash 远程安装拒绝与显式放行 |
| `verify:langparity` | 引擎层不许按语言名分支；脚手架生成的插件六个运行模式都能加载 |

CI（`.github/workflows/ci.yml`）把上述全部当作阻塞闸门，另外会构建 NSIS 安装包、静默安装并探测 `/health`。
每个步骤都是一个 npm 脚本，所以 `npm run ci:pure` 在本机跑的就是 CI 快门；`npm run verify:ci` 检查 workflow 里每个命令都真实存在。

## 和 PyCharm / VS Code 差在哪

写这张表不是为了排名，是为了让"这个项目能做到什么"有一个诚实的边界。✅ = 现在可用且有门禁；
⚠️ = 可用但受上游能力或实现范围限制；❌ = 明确不做（理由见下一节）。

| 能力 | 本项目 | PyCharm | VS Code | 说明 |
|---|---|---|---|---|
| 多语言运行 | ✅ 五种运行模式 | ⚠️ 按解释器/插件 | ✅ 靠 tasks/扩展 | 引擎只认 manifest，不认语言名 |
| 补全 / 悬停 / 跳转 / 引用 / 重命名 / 格式化 / 折叠 / 内联提示 | ✅ | ✅ | ✅ | 能力由语言服务器声明，未声明时如实说 `does not advertise`，不静默失败 |
| 测试树（单用例重跑、失败跳行） | ✅ Go | ✅ | ✅ 扩展 | 其他语言目前按纯输出处理，树只对声明了 `testFormat` 的格式生效 |
| 断点调试（DAP） | ✅ Python / Go | ✅ | ✅ | 通过 `debugpy` / `delve` |
| 重构（Extract / Move / Change Signature） | ⚠️ 重命名走服务器返回的编辑；Extract / Move / Change Signature 明确不做 | ✅ 内建 | ⚠️ 扩展 | 跨文件 WorkspaceEdit 先校验全部目标，再原子替换并按需回滚；未保存缓冲区会拒绝整批 |
| 终端 | ⚠️ 命令面板（一次命令一次 `spawn`） | ✅ 真 PTY | ✅ 真 PTY | 无交互式程序、无作业控制；不要当 vim 用 |
| 工作区 | ⚠️ 单根 | ✅ 多根 | ✅ 多根 | 每个窗口有独立项目根；`openFolder` 后解释器、依赖、模板与调试路径同步换根 |
| 多光标 | ❌ | ✅ | ✅ | CodeMirror 5 的限制，换编辑器是重写级工作 |
| 覆盖率 | ⚠️ Python | ✅ | ⚠️ 扩展 | 其他语言要各写 instrumentation |
| MCP | ⚠️ stdio | — | ⚠️ 扩展 | 无 HTTP/SSE transport |
| 插件市场 | ⚠️ 索引 + `sha256` | ✅ | ✅ | 远程安装默认要求 hash，无 hash 需显式放行；**没有签名**：hash 只保证下载物与索引一致 |
| AI 助手 | ⚠️ 单轮流式 | ✅ | ✅ | 无会话历史、无代码库索引、无工具调用 |

## 不打算做的事

写下来是为了不再反复讨论，也为了不让"待补"列表无限增长：多光标、多根工作区、PTY 终端、
非 stdio 的 MCP、非 Python 的覆盖率、语义级"删除未使用 import"、脚手架期间联网拉依赖、
插件签名链。前六项受实现选择限制（编辑器版本、单根模型、传输层），后两项需要信任根，
在没有密钥体系之前做了也只是装饰。

## 安装包

```bash
npm run build:setup                              # → installer/Nolanguage-Setup.exe（中文向导，22 MiB）
npm run tauri -- build --bundles nsis            # → src-tauri/target/release/bundle/nsis/*.exe
```

- 自研 NSIS：选择安装目录 + 实时进度 + 无控制台，装到 `%LOCALAPPDATA%\Programs\Nolanguage`；
- Tauri 包：Rust 壳 + 引擎 sidecar，装到 `%LOCALAPPDATA%\Nolanguage`；
- 两者可并存，详见 `installer/README.md`。

`build:exe` 结束后会通过 `postbuild:exe` 自动把 `dist/Nolanguage.exe` 同步到 `src-tauri/binaries/NolanguageEngine-<triple>.exe`（sha256 比对），Tauri 构建前也会再同步一次——不会出现"壳新引擎旧"。

## 架构（30 秒版）

```
表现层  panel/pycharm-ui.ts（装配）+ panel/ui/{pycharm-css, pycharm-shell, pycharm-client}
传输层  panel/Transport.ts —— WebSocket ⇄ stdio，同一份协议、同一份 UI
路由层  panel/server.ts    switch(msg.kind) → handle*()
领域层  WorkspaceService（每语言一个 slot）→ langs/Registry → runtimes/*
内核层  kernel/{CommandBus, EventBus, ServiceRegistry}
        perf/PerfSpine · log/LogSpine · correlation/CorrelationBus · store/SqliteStore
```

- **语言零硬编码**：`builtin/<id>@<ver>/manifest.json` 决定扩展名、语法高亮、运行方式、LSP、调试、剖析；新增一门语言不改引擎代码。
- **编辑器**：CodeMirror 5 以 vendor 形式内置（`src/vendor/codemirror/`），语言 id 经 `cmModeFor()` 映射到 CM mode；无布局环境自动回退 textarea。
- **Rust 只做管道**：`src-tauri` 起 sidecar、按行转发 JSON，不解析 `kind`。
- **可观测性内建**：命令/事件/服务天然埋点，日志与性能进 SQLite 温层，支持 baseline 对比。

## 文档

- `docs/STATUS.md` — **现状**：能做什么、缺什么、明确的非目标；每条能力对应的门禁
- `docs/ARCHITECTURE.md` — 分层与预算契约（数字由 `verify:arch` 校验，抄错会失败）
- `docs/添加新语言指南.md` — 一门语言 = 一个目录 + 一份 manifest；先跑 `npm run scaffold:lang`
- `docs/lsp-manager.md`、`docs/project-wizard.md`、`docs/ai-panel-protocol.md` — 语言服务管理器、项目向导、AI 面板协议
- `docs/archive/` — 历史评估，每份都带归档日期，**不再更新**
- `逻辑文档/` — 早期架构与设计记录
- `installer/README.md` — 安装器与卸载路径

## 依赖

运行时依赖 **0 个**（`package.json` 没有 `dependencies` 字段）；开发依赖 8 个（`@tauri-apps/cli`、`@types/node`、`esbuild`、`jsdom`、`postject`、`tsx`、`typescript`、`vitest`），`npm ci` 一次装齐。CodeMirror 5 与 Vue 运行时以 vendor 形式内置（`src/vendor/`），不进入 `package.json`。

## License

待定。
