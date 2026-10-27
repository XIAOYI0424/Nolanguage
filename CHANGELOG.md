# Changelog

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
