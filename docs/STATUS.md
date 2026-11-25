# 项目现状：能做什么，缺什么，为什么

> 版本 0.7.24 · 更新 2026-11-24

这份文档取代了 `docs/archive/` 里那一串按日期命名的评估报告。原因是评估报告的生命周期太长：
它们描述的是"当时的样子"，却一直被后来的人当成"现在的样子"读，于是每过一版就要再写一份，
再被误读一次。现在的规则是：**现状只有这一份，评估只做归档，不再续写**。

数字（套件数、文件数、断言数）不在这里抄写。它们由 `npm run verify` 和
`npm run verify:arch` 现场打印；抄进来的那一刻就已经开始过期了。

## 一句话定位

轻量化的多语言编程工作台：一个 Node 进程同时是语言服务网关、执行平面、调试适配器和
HTTP/WebSocket 服务，前端是一张自包含 HTML。它不是 PyCharm 的替代品，目标是在"打开就能改、
改完就能跑、跑挂能看到原因"这条路上，把每一种语言都做到同一水平，而不是把一种语言做到极致。

## 已经能做的事（每条都有门禁）

| 能力 | 机制 | 门禁 |
| --- | --- | --- |
| 跨语言编辑 | 每个语言插件声明 `grammar`，引擎只认规则表，不认语言名 | `verify:langparity`、`verify:arch`（禁止核心层按语言名分支） |
| 语言服务 | `LspClient` 统一归一化：补全、悬停、签名、跳转、引用、重命名、格式化、折叠、内联提示 | `verify:lsp-protocol`（假服务器 + 缺能力路径） |
| 运行 | 五种模式：`template` / `repl-session` / `directory-session` / `inline-vm` / `script-host` | `verify:go`、`verify:javascript`、`verify:markdown` |
| 测试树 | `go test -v` 增量解析 → 每个用例一行；单用例重跑；失败进 Problems 而不是覆盖诊断 | `verify:ide`（真实执行）、`npm test`（解析器单测） |
| 调试 | DAP：`debugpy` / `delve`，断点、步进、变量、停止 | `verify:ide` |
| 插件 | 清单校验、本地/远程安装、`sha256` 校验、索引搜索 | `scripts/verify-langsource.ts`、`scripts/verify-langcatalog.ts` |
| 新语言 | `npm run scaffold:lang` 生成可加载插件，生成物自带校验 | `verify:langparity`（六种运行模式各生成一次并加载） |
| AI 助手 | OpenAI 兼容的流式 `/chat/completions`，key 只存在应用数据目录 | `verify:ai`（本地 SSE 服务器）、`verify:ui` |
| 面板暴露 | 非回环监听强制 `PANEL_TOKEN`，cookie 承载进 WebSocket 握手 | `verify:panel-auth` |
| 页面体积与启动 | 原始/压缩字节、冷启动、开机零外网请求，三条预算 | `verify:perf` |
| 协议完整性 | 一份 kind 清单，两端 `switch` 都必须与它一致 | `verify:protocol` |
| 前端片段 | 反引号、`${}`、被执行的字符串、重名声明、漏注册的片段 | `verify:client` |
| 项目会话 | 只有被引擎确认的 `openFolder` 根路径才会写入本地偏好，下次启动自动重开；失效路径被清理并回退默认根目录 | `verify:pycharm` |
| 项目解释器 | 候选列出版本、来源与虚拟环境类型；可选任意编译器路径（输入或系统文件选择）；按项目记住选择；有本地 venv/conda 时默认采用 | `verify:pycharm`、`verify-migration`、`verify-workspace-env` |
| 编辑器导航小功能 | Find Action 直接索引真实菜单动作；行书签（匿名/助记，偏好持久化）；Ctrl+Tab 按 MRU 切换标签；TODO 工具窗用既有 fs 协议做有界扫描，点击跳转到对应文件行 | `verify:pycharm` |
| 项目级查找 | Find in Files 有界递归扫描工作区并合并已打开缓冲区结果；支持大小写、正则与逗号分隔文件掩码；保存、切换根目录和 `fsChanged` 后刷新 | `verify:pycharm` |
| 本地历史 | 写入、重命名、删除与 WorkspaceEdit 前把原文快照写入应用数据目录；Recent Changes 可并排比较和回退，回退本身也是可再次撤销的普通写入 | `verify:pycharm`、`npm test` |
| 剪贴板比较 | Code 菜单的 Compare with Clipboard 生成轻量逐行差异，每侧上限 600 行，复用同一差异查看器 | `verify:pycharm` |
| 草稿文件与缓冲 | 草稿只存在 IDE 偏好里，不写工作区；保存直接落偏好，重启后恢复内容和当前草稿标签 | `verify:pycharm` |
| 编辑器查找与恢复 | Find 栏显式 Match case / Whole word / Regex（含正则捕获组替换与非法表达式提示），选择写入偏好；Ctrl+Shift+T 按"最后关闭先恢复"重开标签并还原光标；Compare with Saved Version 读取磁盘副本做差异而不替换内存缓冲区 | `verify:pycharm` |
| 符号帮助与括号跳转 | Ctrl+Q 先显示本地兜底说明，同时发真实 LSP hover，同一对话框收到回答后原地升级；Ctrl+Shift+M 跳过字符串与注释里的括号，按括号栈跳到匹配处并如实报告无匹配 | `verify:pycharm` |
| 日常编辑器闭环 | 快捷键提示与实际绑定一致；Search Everywhere 用有界 fsList 索引真实工作区文件，Symbols、Go to Symbol 对话框和 Structure 窗口都走 workspaceSymbol，并在服务不支持时退回本地声明；标签切换、Ctrl+Tab 与 Alt+Left/Right 恢复光标、选区和滚动；项目树 F2 就地重命名；File > Save All 只写有改动的真实文件；Find in Files 支持 Whole word，并可预览、勾选项后批量替换 | `verify:pycharm`、`verify:client` |
| 编辑器外壳操作 | `Ctrl+S` 保存当前窗口所有已改动的真实文件并保留格式化、LSP 检查与失败保持 dirty 的路径；项目树支持上下选择、左右折叠/展开、Enter 打开，F2 仍可重命名；F5 与右键 Refresh 重新拉取缓存目录，外部新增文件可见且已展开状态保留；Copy Absolute Path 输出规范化的完整路径；Navigate 菜单与 Find Action 能找到并启动 Find in Files、Go to Definition、Find Usages；隐藏标签按钮弹出完整标签选择器，标签中键关闭沿用未保存确认流程 | `verify:pycharm`、`verify:client` |
| 高频键盘闭环 | 编辑器焦点下 F2 / Shift+F2 在当前文件诊断间跳转，F3 / Shift+F3 复用上次查找查询；Ctrl+Shift+R 进入已有的项目替换预览，Ctrl+Shift+U 切换选中文本大小写；Alt+F1 在项目中定位当前文件，Ctrl+Alt+Shift+C 复制相对路径与行号，Ctrl+Shift+Backspace 回到有界记录的上次编辑位置 | `verify:pycharm`、`verify:client` |
| 程序员效率操作 | Alt+Down / Alt+Up 在当前文件的声明之间跳转；Ctrl+Shift+I 以只读预览显示 Quick Definition，本地声明先出现、LSP 回答再原地升级且不移动光标；Ctrl+Shift+F7 高亮当前文件中的代码用法，跳过字符串与注释；Ctrl+Backspace / Ctrl+Delete 按词删除并处理相邻空白；Ctrl+Shift+V 从会话内剪贴板历史粘贴；Ctrl+W / Ctrl+Shift+W 按词、行、段落、全文分级扩展或收缩选择；面包屑的目录、文件与符号段都可点击定位，缩略图带视口指示和点击滚动；项目树 Compare with File 用两次独立 `fsRead` 复用既有差异查看器，不会替换编辑器缓冲区 | `verify:pycharm`、`verify:client` |
| 编辑器细节打磨 | 弹窗和输入控件不再抢编辑器快捷键，Escape 与 Search Everywhere 的上下键仍由各自控件处理；Tab、回车自动缩进、Indent Selection 与 Reformat 统一使用 Preferences 里的制表符/宽度设置；复制、系统粘贴与程序化编辑都进入剪贴板历史和 Last Edit Location；Ctrl+Shift+Backspace 在编辑器焦点下不再被按词删除抢走；Go to Line 预填当前行并把越界行号夹取到真实末行；Ctrl+/ 覆盖 TypeScript 等常见语言的行注释前缀 | `verify:pycharm`、`verify:client` |
| 批量替换安全边界 | Replace in Files 先按精确 span 生成编辑，拒绝有未保存改动的缓冲区；跨文件写入改为同目录临时文件 + 原子替换，回滚按逆序覆盖包括当前失败文件在内的所有目标 | `verify:pycharm`、`npm test`、`verify:arch` |
| 命令面板与项目根 | 本地内建按真实空白分词，不再把 `ls` 截成 `l`；`openFolder` 更新连接自己的项目根，并同步工作区的 `projectRoot`、插件 project 层、工具链发现、解释器、依赖、模板与调试路径；两个窗口可分别打开不同目录而不互相换根 | `verify:pycharm`、`verify:workspace-env` |
| 调试预构建 | `debug.preLaunch` 首选 `argv` 数组，按进程参数执行且不经 shell；旧 `cmd` 只在本机分词后作为 argv 运行，带空格或 `&` 的路径不再改变实际命令 | `npm test` |
| 插件来源边界 | zip/tar 除防逃逸外还限制条目数、单条目未压缩字节与总展开字节；http(s) 安装默认要求 SHA-256，无 hash 需显式 `--sha256` / `--allow-unverified`（面板对应 `allowUnverified`），本地目录和 git 不受下载约束 | `scripts/verify-langsource.ts` |

## 已知的差距

按"影响判断"排序，而不是按工作量。

1. **命令面板不是终端**。`termExec` 是"一次命令一次 spawn"，没有 PTY、没有交互式程序、没有作业控制。
   它是命令执行面板，不是 shell；`vim` 之类的交互程序打不开是设计边界，不是 bug。
2. **重构只覆盖重命名和 Quick Fix**。Extract Method / Variable / Constant、Move、Change Signature
   需要项目级语义分析和重构编辑，当前语言服务协议不提供；这些菜单项和快捷键已经移除，
   不再用"未实现"提示冒充功能。重命名和 Quick Fix 的 WorkspaceEdit 现在会走
   `applyWorkspaceEdits`：服务端先校验全部目标文件，再写入全部文件；任一文件无效则一个都不写，
   写入中途失败会按逆序原子回滚，连当前失败文件也一并恢复。有未保存改动的缓冲区会拒绝跨文件重命名，
   避免用错误的行号改磁盘文件。
3. **单根工作区**。`openFolder` 换根，但没有多根、没有跨根搜索；monorepo 里同时改两个包要靠开两个窗口。
4. **覆盖率只有 Python**。其他语言的覆盖率需要各家的 instrumentation，属于"要写适配器"而不是"接个参数"。
5. **MCP 只有 stdio**。没有 HTTP/SSE transport，也没有 OAuth 之类的授权流程。
6. **插件签名没有做**。远程安装现在默认要求 `sha256`，无 hash 必须显式放行；但 hash 只保证
   "下载到的和索引里写的是同一份"，索引本身被篡改时它保护不了你。这一点在
   `docs/添加新语言指南.md` 里也写明，不要在别处说成"插件市场是安全的"。
7. **AI 是单轮**。没有会话历史、没有代码库索引、没有工具调用；它读的是你贴进去的那段文本。
8. **编辑器是 CodeMirror 5**。多光标、多选、部分现代编辑体验做不到；升级是重写级别的工作，不在当前计划里。
9. **Tauri 打包未在 CI 里验证**。`src-tauri` 与 sidecar 脚本存在，但没有一条门禁真的启动过打包产物。

## 工程质量债（已知，不是"待补清单"）

- **核心域的单测密度不足**。解析器、manifest、AI SSE 这类纯函数覆盖较好，但 `WorkspaceService`、
  `server.ts`、LSP 调度和进程捕获主要靠端到端脚本：真实，但定位慢、边界穷举不了。
  新增的核心逻辑优先写成纯函数再补单测——`src/lsp/workspaceEdits.ts` 和
  `src/panel/handlers/fs.ts` 的跨文件编辑就是按这个顺序做的。
- **行数预算会反向塑造结构**。1200 行上限已经导致过几次"为数字挪代码"。拆分本身有益，
  但预算应该约束依赖方向和职责，而不是单纯字数；`WorkspaceService` 的豁免本身就是债，
  不是可以反复引用的先例。
- **前端靠 `esc()` 纪律，没有 CSP**。大量 `innerHTML` 拼接放着"漏转义"的空间。
  AI 回答走 `textContent`，方向正确，但这是纪律不是机制；真正兜底需要 CSP 或结构化 DOM。
- **CI 只有 Windows**。四个 job 都在 `windows-latest`，路径大小写、symlink、`cmd.exe` 语义
  没有第二平台证据。这不是"跨平台已支持"，只是"未在别的平台证伪"。
- **发布状态与代码状态不同步**。工作树里有大量未提交改动时，包版本号不代表这些改动已经
  进入产物；tag 应打在完整可构建的树上，不要先发版本再补提交。

## 明确的非目标

不打算做的事，写下来是为了不再反复讨论：多光标、多根工作区、PTY、非 stdio 的 MCP、
非 Python 的覆盖率、语义级的"删除未使用 import"、脚手架期间联网拉依赖。
`docs/archive/` 里的历史评估多次把这些列成"待补"，这里的答案是"不补，且理由如上"。

## 文档怎么读

- 现在：本文档。
- 架构与分层：`docs/ARCHITECTURE.md`（数字由门禁校验）。
- 加一种语言：`docs/添加新语言指南.md`（先跑 `npm run scaffold:lang`）。
- 语言服务管理：`docs/lsp-manager.md`。
- 项目向导：`docs/project-wizard.md`。
- AI 面板协议：`docs/ai-panel-protocol.md`。
- 历史：`docs/archive/`，每份都带归档日期和"已被本文取代"的说明。
