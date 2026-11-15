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

Python 语言插件已随包内置（`builtin/python@1.0.0`），装完即可新建 `.py` 运行；Go / JavaScript / Markdown 同理。

编辑器内置 **CodeMirror 5.65.21**（vendor 在 `src/vendor/codemirror/`，随页面内联，不走 CDN，也不是 npm 依赖）：语法高亮、括号匹配、自动闭合、当前行、行号、补全弹窗。没有布局引擎的环境（jsdom 测试）会自动回退到原来的 `<textarea>` + 高亮层，所以同一份页面在浏览器 / Edge 窗口 / 测试里都能跑。

## 插件

引擎零硬编码：一门语言由 `manifest.json` 描述，插件装好即生效。内置 `python` / `go` / `javascript` / `markdown` 在 `builtin/<id>@1.0.0/`，第三方插件装进插件主目录：

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
| `lang add <目录\|zip\|tar.gz\|url\|git\|id>` | 安装并启用；`--strict` 在运行时依赖缺失时拒绝安装；裸 id 从插件索引解析 |
| `lang search [query]` | 从插件索引检索（`--source <url>` 追加索引） |
| `lang on <id>` / `off <id>` | 启用 / 禁用 |
| `lang info <id>` | 单个插件全量信息 |
| `lang deps [id]` | 运行时依赖是否满足 |
| `lang up <id> [source]` | 按记录的来源重装 |
| `lang rm <id> [--drop-data]` | 卸载（默认保留 data，`--drop-data` 一并删除） |

```bash
Nolanguage.exe lang add ./examples/cpp@1.0.0
Nolanguage.exe lang add https://example.org/cpp.zip
Nolanguage.exe lang add https://github.com/someone/nolang-rust.git
Nolanguage.exe lang search lsp
Nolanguage.exe lang ls
```

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
npm run verify           # 49 套件（真进程，含打包 exe smoke + 打包 exe 的 MCP 面板 + 语言一致性门禁）；断言总数以本次输出为准
npm test                 # vitest 单测（2 个文件 38 用例；丢了文件会失败）
npm run typecheck        # tsc --noEmit，0 错误
npm run verify:sidecar   # 校验 dist 与 Tauri sidecar 的 sha256 一致
npm run verify:ui-live   # 可选：真浏览器（headless Edge + CDP）跑编辑器与导航按键；缺 Edge 则 SKIP
```

`verify:ui-live` **不在** `verify` 的 49 套里：它需要 Edge、一个空闲端口和打包好的 exe，把无头浏览器设为必过项在 CI runner 上只会带来抖动。改动编辑器、键位或导航分片之后手动跑一次——jsdom 看不到 CodeMirror 拥有文档、真实焦点、真实按键这些最容易悄悄坏掉的部分。

CI（`.github/workflows/ci.yml`）把上述全部当作阻塞闸门，另外会构建 NSIS 安装包、静默安装并探测 `/health`。
每个步骤都是一个 npm 脚本，所以 `npm run ci:pure` 在本机跑的就是 CI 快门；`npm run verify:ci` 检查 workflow 里每个命令都真实存在。

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

- `逻辑文档/` — 架构、项目框架、安装与语言支持现状、项目评估
- `docs/` — 架构契约（`ARCHITECTURE.md`）、插件作者指南（`添加新语言指南.md` 等）、按日期归档的评估
- `installer/README.md` — 安装器与卸载路径

## 依赖

运行时依赖 **0 个**（`package.json` 没有 `dependencies` 字段）；开发依赖 8 个（`@tauri-apps/cli`、`@types/node`、`esbuild`、`jsdom`、`postject`、`tsx`、`typescript`、`vitest`），`npm ci` 一次装齐。CodeMirror 5 与 Vue 运行时以 vendor 形式内置（`src/vendor/`），不进入 `package.json`。

## License

待定。
