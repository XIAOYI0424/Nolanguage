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

源码模式（开发用）：

```bash
npm run panel            # 同 `nlg web`：起服务并提示地址
npm run ide              # 前台运行面板服务（Ctrl+C 结束）
```

Python 语言插件已随包内置（`builtin/python@1.0.0`），装完即可新建 `.py` 运行；Go / JavaScript / Markdown 同理。

## 验证

```bash
npm run verify           # 29 套件 / 1332 条断言（真进程，含打包 exe smoke）
npm test                 # vitest 单测（9 用例）
npm run typecheck        # tsc --noEmit，0 错误
npm run verify:sidecar   # 校验 dist 与 Tauri sidecar 的 sha256 一致
```

CI（`.github/workflows/ci.yml`）把上述全部当作阻塞闸门，另外会构建 NSIS 安装包、静默安装并探测 `/health`。

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
- **Rust 只做管道**：`src-tauri` 起 sidecar、按行转发 JSON，不解析 `kind`。
- **可观测性内建**：命令/事件/服务天然埋点，日志与性能进 SQLite 温层，支持 baseline 对比。

## 文档

- `逻辑文档/` — 架构、项目框架、安装与语言支持现状、项目评估
- `docs/` — 插件作者指南（`添加新语言指南.md` 等）
- `installer/README.md` — 安装器与卸载路径
- `.codebuddy/index/` — 如存在，为内容索引

## 依赖

运行时依赖 1 个（`@tauri-apps/plugin-dialog`）；开发依赖 5 个（tauri-cli、types、tsx、typescript、vitest）。构建工具（esbuild / postject / jsdom）按需临时安装，不写入 `package.json`。

## License

待定。
