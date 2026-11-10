# 评估：新增语言模块 / 虚拟环境 / C·C++ CMake / 内置库

> 基于当前代码（HEAD `08a0455`）实读，不是方案推演。
> 结论先行：**新增语言是低摩擦的**；**虚拟环境目前没有抽象**；**CMake 可以不改引擎做出来，但缺"多文件同步"和"LSP cwd"两块**；**内置库要分三种含义分别处理**。

---

## 0. 结论摘要

| 问题 | 结论 | 改动量 |
|---|---|---|
| 新增一个语言模块 | 纯 `manifest.json` 即可（+ 可选 LSP/调试/剖析/CM mode）。基座已支持，`verify-langplugins` 会自动扫 `examples/` 校验 | 纯声明 0.5–1 天；带 LSP/调试 2–5 天 |
| 创建新的虚拟环境（venv/conda/nvm…） | **当前没有"环境"抽象**：只有 `data/<id>/sessions/<id>` 目录、`scaffold.onFirstRun`（只写文件）、`run.env`（注入环境变量）。要做真正的 venv，需要新增一次性 `prepare` 步骤或新运行时 | 原型 1–2 天；通用环境抽象 3–5 天 |
| C/C++ CMake | 用 `directory-session` + `scaffold`（CMakeLists.txt）+ 多步（configure/build/run）+ `lsp.args` 可做；**缺**"把工作区多文件同步进 session"和"clangd 的 cwd" | 插件 1–2 天；补两处能力 2–3 天 |
| 内置库 | 三种含义：① 插件自带标准库/运行时（`run.env` 注入路径，现成）② C/C++ 系统头/库（编译器默认 + `CPLUS_INCLUDE_PATH`/`LIBRARY_PATH`/`CMAKE_PREFIX_PATH`）③ 随应用内置（`builtin/` 打包，现成）。**没有** vcpkg/conan 包管理器集成 | ①③ 0 天；② 0.5 天；包管理器 5–10 天 |

---

## 1. 现状盘点（与评估直接相关的代码）

| 能力 | 位置 | 现状 |
|---|---|---|
| 语言声明 | `src/langs/manifest.ts` | `LanguageManifest`：`file` / `grammar` / `scaffold` / `lsp` / `run` / `debug` / `profiler` / `migrations` / `contributes` |
| 运行装配 | `src/langs/RunnerFactory.ts` | 只按 `run.mode` 找运行时；三条硬失败（运行时缺 / 版本不满足 / 配置非法） |
| 工具链发现 | `src/langs/discover.ts` | `envVars → knownPaths → commands(PATH)`；`opts.toolchain[id]` 可 pin |
| 五种运行时 | `src/runtimes/` | `template`（mkdtemp 临时目录）、`repl-session`（`data/<id>/sessions/<id>`）、`directory-session`（同上）、`inline-vm`、`script-host` |
| 步骤引擎 | `src/runtimes/steps.ts` | `RunStep{role:build|run|test, cmd, timeoutMs}`；`{file}{workdir}{basename}{data}{toolchain}{exe}`；`build` 失败 → `compileError` |
| 脚手架 | `src/runtimes/types.ts` | `ScaffoldFile{file, template}`：**只写文件，不执行命令** |
| 环境变量 | `src/runtimes/types.ts` | `RunConfig.env` 会合并进子进程；`RunRequest.env` 再覆盖 |
| LSP 启动 | `src/panel/WorkspaceService.ts:600` | `discoverBinary` → `LspLaunchSpec{command,args}`；**没有设置 `cwd`**，`LspClient` 回落 `process.cwd()` |
| LSP 规格 | `src/langs/manifest.ts` | `LspSpec` 有 `args` / `discovery` / `requiresProjectFile` / `memoryHint`，**没有 `cwd` / `env`** |
| IDE 运行 | `src/panel/server.ts:975` | `handleRun` 只传 `code/sessionId/mode`，**不传 `cwd`** |
| 编辑器高亮 | `src/panel/ui/pycharm-client.ts` | CodeMirror 5；`cmModeFor()` 映射语言 → CM mode；没有 mode 就纯文本（textarea 回退仍用 `grammar.rules`） |
| 内置插件 | `builtin/<id>@<ver>/` | 随 exe 打包、只读、不可卸载；与用户插件格式相同 |

---

## 2. 新增一个语言模块

### 2.1 最小可用（能打开、高亮、编辑）

```json
{
  "id": "mylang",
  "displayName": "MyLang",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "file": { "extensions": ["ml"], "defaultExt": "ml" },
  "grammar": { "rules": [{ "re": "//[^\\n]*", "cls": "c" }] }
}
```

放到 `examples/mylang@1.0.0/` 或 `~/.nolanguage/languages/mylang@1.0.0/`，`verify-langplugins` 会自动做 `validateManifest` + `RunnerFactory.diagnose` 双查。

### 2.2 能运行（选一种运行时）

| 语言形态 | 运行时 | 关键字段 |
|---|---|---|
| 编译后运行（rustc/javac/dotnet/gcc） | `template` | `run.steps[{role:'build'},{role:'run'}]` |
| 需要持久会话（Python/Node REPL） | `repl-session` | `run.command` + `bootstrap` |
| 包/模块目录（Go module、CMake 工程） | `directory-session` | `run.command` / `steps` + `scaffold` |
| 纯表达式（DSL） | `inline-vm` | `vmTimeoutMs` |
| 以上都不合（自定义执行模型） | `script-host` | `run.script` + `runtime.js` |

### 2.3 加 LSP / 调试 / 剖析

- `lsp`：`discovery` + `command` + `args` + `languageId` + `serverName` + `degradedNote`；`requiresProjectFile` 决定"degraded"还是"broken"。
- `debug`：`adapter` + `type` + `discovery` + `command`；未装 → `degradedNote`。
- `profiler`：`adapter`（当前注册了 `cProfile` / `pprof`；新工具要在 `src/profiler/adapters.ts` 注册，否则**响亮报错**）。

### 2.4 加 CodeMirror 高亮

1. 把 `mode/<lang>/<lang>.js` 放到 `src/panel/vendor/codemirror/mode/<lang>/`；
2. 在 `src/panel/ui/codemirror-assets.ts` import 并按顺序加入 `CODEMIRROR_JS`；
3. 在 `pycharm-client.ts` 的 `cmModeFor()` 加 `case 'mylang': return 'mylang';`。

没有 CM mode 也能用：CM 显示纯文本，textarea 回退仍按 `grammar.rules` 高亮。

### 2.5 工作量

- 纯声明 + 单文件运行：**0.5–1 天**（含 manifest、示例、verify 通过）。
- 加 LSP（找到服务器、调通诊断/补全）：**1–2 天**。
- 加调试 / 剖析：**1–2 天**。
- CM mode：**0.5 天**。

---

## 3. 虚拟环境（venv / conda / nvm / rustup）

### 3.1 现状

- `template` 每次用 `mkdtemp`（临时目录，`close()` 删除）；`repl-session` / `directory-session` / `script-host` 用 `data/<id>/sessions/<id>`（持久）。
- `scaffold.onFirstRun` 只**写文件**，不执行命令。
- `RunConfig.env` 可注入 `PATH` / `VIRTUAL_ENV` / `PYTHONPATH`。
- **没有**"环境"实体：没有创建、激活、缓存标记、失败恢复的抽象。

### 3.2 三条实现路径

**A. 纯 manifest（零引擎改动）**

```json
"run": {
  "mode": "directory-session",
  "command": ["{toolchain}"],
  "scaffold": { "onFirstRun": [
    { "file": "requirements.txt", "template": "requests==2.32.3\n" }
  ]},
  "steps": [
    { "role": "build", "cmd": "\"{toolchain}\" -m venv .venv" },
    { "role": "build", "cmd": "\"{workdir}/.venv/bin/python\" -m pip install -r requirements.txt" },
    { "role": "run", "cmd": "\"{workdir}/.venv/bin/python\" \"{file}\"" }
  ]
}
```

问题：`venv` 创建不是幂等的（第二次会复用，但 `pip install` 每次跑）；Windows 路径是 `.venv\\Scripts\\python.exe`；失败后没有"重建"语义。适合原型，不适合长期。

**B. 新增 `prepare` 一次性步骤（推荐的最小引擎改动）**

给 `RunStep` 加 `once?: boolean`（或 `role: 'prepare'`），`runSteps` 用 session 标记（`data/<id>/sessions/<id>/.prepared.json`）跳过已完成的步骤。manifest：

```json
"steps": [
  { "role": "prepare", "once": true, "cmd": "\"{toolchain}\" -m venv .venv" },
  { "role": "prepare", "once": true, "cmd": "\"{workdir}/.venv/bin/python\" -m pip install -r requirements.txt" },
  { "role": "run", "cmd": "\"{workdir}/.venv/bin/python\" \"{file}\"" }
]
```

改动：`RunStep.once` + `runSteps` 的 session 标记 + `resetSession` 清标记。约 **1–2 天**（含测试）。这是最干净的通用方案。

**C. `script-host` 插件自带逻辑**

`runtime.js` 里自己判断/创建 venv、写标记、返回 `{t:'out'}`。零引擎改动，但把环境逻辑放进插件（第三方可写），且每个语言重复实现。

### 3.3 推荐

1. 先用 **A** 做 Python venv 原型（1 天），验证闭环；
2. 如果第二种语言也需要环境，升级到 **B**（`prepare` 一次性步骤）；
3. 目录放 `data/<id>/env/<name>`（可写），不要放插件目录（只读）；卸载默认保留（keepData）。
4. 资源预算：venv 的 RSS 不进 `ProfileManager`（它是磁盘/进程，不是常驻服务器）；但 `pip install` 的进程应受 `run.timeoutMs` 约束。

---

## 4. C/C++ CMake

### 4.1 现状

`examples/cpp@1.0.0` 是 `template` + g++ 单文件：

```
g++ -std=c++17 -O0 main.cpp -o nl_main.exe   （role build）
./nl_main.exe                                  （role run）
```

适合单文件练习；CMake 工程需要：稳定目录、多文件、configure/build 两步、`compile_commands.json` 给 clangd、可执行文件路径。

### 4.2 方案（不改引擎）

```json
{
  "id": "cpp-cmake",
  "run": {
    "mode": "directory-session",
    "command": ["cmake"],
    "scaffold": { "onFirstRun": [
      { "file": "CMakeLists.txt", "template": "cmake_minimum_required(VERSION 3.20)\nproject(app CXX)\nadd_executable(app main.cpp)\n" }
    ]},
    "steps": [
      { "role": "build", "cmd": "cmake -S \"{workdir}\" -B \"{workdir}/build\" -DCMAKE_EXPORT_COMPILE_COMMANDS=ON" },
      { "role": "build", "cmd": "cmake --build \"{workdir}/build\" --config Release" },
      { "role": "run", "cmd": "\"{workdir}/build/app{exe}\"" }
    ]
  },
  "lsp": {
    "args": ["--compile-commands-dir=build", "--background-index", "--query-driver=**/g++*"],
    "requiresProjectFile": "CMakeLists.txt"
  }
}
```

### 4.3 两个真实缺口

1. **多文件同步**：`directory-session` 的 `materialiseSource` 只写一个入口文件（`main.cpp`），**不会把工作区其它 `.cpp/.h` 复制进 session**。真实 CMake 工程会缺源文件。
   - 方案 A：给 `directory-session` 加 `syncWorkspace?: boolean`，把工作区文件复制到 session（忽略 `build/`、`.git/`）。
   - 方案 B：让 `RunRequest.cwd` 支持工作区根，直接在工作区里 configure/build（不复制）。`handleRun` 目前不传 `cwd`，需要加一个 `cwd` 字段。
   - 方案 C：用 `script-host` 自己 `fs.cp`（零引擎改动，但插件变重）。
2. **clangd 的 cwd**：`WorkspaceService.startLsp` 不设置 `LspLaunchSpec.cwd`，`LspClient` 回落 `process.cwd()`（引擎进程目录，不是工作区根）。`--compile-commands-dir=build` 会相对错误的目录。
   - 方案：`LspSpec` 加 `cwd?: string`（支持 `{workspace}` 占位），`startLsp` 传入；或 `LspSpec.args` 用绝对路径（插件不知道工作区路径，不现实）。
   - 工作量：**0.5 天**（加字段 + 测试）。

### 4.4 其他

- **增量构建**：`cmake --build build` 天然增量；`directory-session` 的 session 目录持久，configure 只在文件变化时重跑（可用 `once` 步骤）。
- **调试**：`codelldb` 的 `program` 指向 `build/app`；当前 DAP 只负责启动 adapter，launch 参数由 IDE 发（需确认 `DapClient` 的 launch 是否支持 `program`/`cwd`）。
- **工具链发现**：`g++` / `clang++` / `cmake` / `clangd` 都可走 `discovery`；CMake 本身要加进 `run.discovery`（或单独一个 `cmake` 发现块）。
- **Windows**：MinGW 的 `build/app.exe`；MSVC 的 `build/Release/app.exe`。建议 `run` 步骤用 `cmake --build` 后跑 `build/app{exe}`，或让 CMake 输出到固定目录。

### 4.5 工作量

- `cpp-cmake` 插件（单文件 + CMakeLists）：**1 天**。
- 多文件同步（方案 A/B）：**1–2 天**。
- clangd `cwd` / `compile_commands`：**0.5 天**。
- 调试 launch 参数：**0.5–1 天**。

---

## 5. 内置库

### 5.1 三种含义

**① 插件自带标准库/运行时**（比如某语言需要自己的 stdlib）
- 插件目录只读，可放 `lib/`；`run.env` 注入 `PYTHONPATH` / `NODE_PATH` / `LD_LIBRARY_PATH` / `PATH`。
- 现成能力，**0 引擎改动**。

**② C/C++ 系统头/库**
- 编译器自带（libstdc++ / MSVC CRT）。
- 额外路径：`CPLUS_INCLUDE_PATH` / `LIBRARY_PATH` / `CMAKE_PREFIX_PATH`（`run.env`）。
- clangd 需要 `compile_commands.json` 或 `--query-driver` 才能找到系统头；Windows 上 MinGW 的头路径 clangd 不一定自动识别，**必须加 `--query-driver=C:/mingw64/bin/g++.exe`**。
- 工作量：**0.5 天**（调通 + 写进示例）。

**③ 随应用内置（`builtin/`）**
- 把插件放 `builtin/<id>@<ver>/`，构建时打进 exe（`scripts/build-exe.mjs` 的 embedded assets），只读、不可卸载、只能禁用。
- 现成机制，**0 引擎改动**；注意体积（exe 已经 91 MiB）。

### 5.2 没有的能力

- **vcpkg / conan 包管理器集成**：自动下载、缓存、注入 include/lib 路径。需要新能力（下载 + 缓存 + 环境注入 + 许可证审计），**5–10 天**，建议独立阶段。
- **依赖版本求解**：`lang add --strict` 只校验运行时依赖，不解析语言库依赖。

---

## 6. 建议的实施顺序

1. **`cpp-cmake` 插件**（directory-session + scaffold + 多步 + clangd args）——1 天，验证 CMake 闭环。
2. **补 `directory-session` 多文件同步**（或 `handleRun` 传 `cwd`）——1–2 天。
3. **补 `LspSpec.cwd`**（clangd 的 `compile_commands.json`）——0.5 天。
4. **`prepare` 一次性步骤**（venv 原型）——1–2 天。
5. **包管理器集成**（vcpkg/conan）——独立阶段 5–10 天。
6. 文档：`docs/添加新语言指南.md` 加 CMake / venv 配方；`语言插件化设计.md` 加环境能力。

---

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| CMake 多文件不同步 | 工程缺文件，构建失败 | 先做单文件示例；再补同步/cwd |
| clangd 找不到系统头 | Check/补全报错 | `--query-driver` + `compile_commands.json` |
| venv 跨平台路径 | Windows `.venv\\Scripts` vs Unix `.venv/bin` | manifest 里用 `{exe}` 或脚本判断；或 `prepare` 运行时封装 |
| 环境目录写进插件目录 | 升级/卸载丢环境 | 放 `data/<id>/env`，keepData |
| 包管理器下载不可控 | 离线环境失败 | 明确"仅在线"；失败降级为 SKIP |

---

## 8. 验证建议

- `verify-langplugins`：自动扫 `examples/` 每个目录（`validateManifest` + `RunnerFactory.diagnose`）。
- 新增 `verify-cpp-cmake.ts`：`cmake` 存在则真实 configure/build/run，缺则 SKIP；断言 `compile_commands.json` 生成。
- 新增 `verify-env.ts`：venv 创建幂等、失败恢复、`resetSession` 清理、跨平台路径。
- `verify-pycharm`：CM mode 映射（`cmModeFor('cpp') === 'clike'?` 目前 cpp 没有 vendored mode，会纯文本；如果要 CM 高亮，需要 vendor `mode/clike/clike.js` 并在 `cmModeFor` 加 `cpp`）。

> 备注：当前 `cpp@1.0.0` 在 CodeMirror 下是**纯文本**（`cmModeFor` 没有 `cpp`）。要 C++ 高亮，需 vendor `mode/clike/clike.js`（`mode/cpp` 依赖 clike）并加映射；这是 0.5 天的小项。
