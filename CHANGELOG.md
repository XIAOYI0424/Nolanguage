# Changelog

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
