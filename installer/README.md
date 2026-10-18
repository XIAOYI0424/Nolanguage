# Nolanguage · 安装器（Setup）

本目录提供三种把 Nolanguage 装到机器上的方式，三者都**同时提供 Web 与 Desktop 两种启动形态**——同一份 `Nolanguage.exe`，只差启动参数：

| 入口 | 启动方式 | 说明 |
|---|---|---|
| **Nolanguage (Web)** | `Nolanguage.exe --open-browser` | 本地 HTTP+WebSocket 服务，用系统默认浏览器打开 |
| **Nolanguage (Desktop)** | `Nolanguage.exe` | 用系统 WebView 引擎开一个无边框原生窗（零依赖，见报告 §3.9） |

> `dist/Nolanguage.exe` 是 Node SEA 单文件、自带运行时，双击即开 workspace；`--open-browser` 只是把它从"原生窗"切换成"浏览器"渲染。

---

## 方式零：自包含安装器 Nolanguage-Setup.exe（推荐，无需任何工具链）

`Nolanguage-Setup.exe`（已构建好，85.9 MiB，Node SEA）是**真正的 .exe 安装程序**，自带运行时、不依赖 NSIS / WiX / Rust 工具链。它从同目录 `payload/Nolanguage.exe` 读取 app，装到用户目录并生成「Nolanguage (Web)」/「Nolanguage (Desktop)」两个开始菜单入口 + 卸载项，可选写入用户 PATH。

**分发方式**：把 `Nolanguage-Setup.exe` 与 `dist/Nolanguage.exe`（放在 `installer/payload/Nolanguage.exe` 或任意同目录 `payload/`）一起发出去即可。

**重新构建**：

```bash
npm run build:exe                    # 先确保 dist/Nolanguage.exe 是最新的（含 --open-browser）
node installer/build-setup.mjs       # 重建 installer/Nolanguage-Setup.exe
```

> 这就是"setup 文件"的推荐形态：双击即装，不需要任何第三方打包工具。

## 方式一：NSIS 安装包（有 makensis 的环境）

`Nolanguage.nsi` 是 NSIS 源。构建需要本机装了 [NSIS](https://nsis.sourceforge.io)（`makensis` 在 PATH）：

```bash
installer\build-nsis.bat                 # 默认用 dist\Nolanguage.exe
makensis /DAPP_EXE=dist\Nolanguage.exe installer\Nolanguage.nsi
```

产物：`installer\Nolanguage-Setup.exe`。它把 exe 装到 `%LOCALAPPDATA%\Programs\Nolanguage`，并建立上述两个开始菜单快捷方式 + 卸载程序（开始菜单"Uninstall Nolanguage" + 注册表卸载项）。无需管理员权限。

> 想同时拿到 Tauri 原生壳的独立安装包，见 `npm run tauri build`（产物在 `src-tauri/target/release/bundle/`），那是另一种 Desktop 形态（Rust 窗 + Node sidecar）。

## 方式二：PowerShell 安装器（无需任何工具链，立即可用）

`setup.ps1` 不依赖 NSIS，只要一台 Windows + PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File installer/setup.ps1
```

它会把**同目录下的 `Nolanguage.exe`** 拷到 `%LOCALAPPDATA%\Programs\Nolanguage`，创建同样的开始菜单快捷方式、桌面快捷方式、卸载项，并可把安装目录加入用户 PATH。

**分发方式**：把 `setup.ps1` 和重新构建好的 `Nolanguage.exe` 放进同一个文件夹，把这个文件夹发出去即可。构建 exe：`npm run build:exe`（→ `dist/Nolanguage.exe`），再拷到 `installer/` 或任意同目录。

卸载：开始菜单"Uninstall Nolanguage"，或运行安装目录里的 `uninstall.ps1`。

---

## 构建单机 exe（两种方式都依赖它）

```bash
npm run build:exe     # → dist\Nolanguage.exe（Node SEA，自带运行时）
```

随后：
- 自包含安装器（方式零）：`node installer/build-setup.mjs` 重建 `installer/Nolanguage-Setup.exe`（运行时才从 `payload/Nolanguage.exe` 读取 app）。
- NSIS 方式：`installer\build-nsis.bat` 会先确保 `dist\Nolanguage.exe` 是最新的。
- PowerShell 方式：把 `dist\Nolanguage.exe` 复制到 `setup.ps1` 同目录。

## CLI 对应命令

开发/命令行下，等价的两个入口是：

```bash
nlg web            # 启动服务并用默认浏览器打开
nlg desktop        # 启动服务并开原生 WebView 窗
nlg web --no-open  # 仅启动服务（CI / 无头）
```
