# Nolanguage · 安装器（Setup）

本目录提供两种把 Nolanguage 装到机器上的方式，两者都**同时提供 Web 与 Desktop 两种启动形态**——同一份 `Nolanguage.exe`，只差启动参数：

| 入口 | 启动方式 | 说明 |
|---|---|---|
| **Nolanguage (Web)** | `Nolanguage.exe --open-browser` | 本地 HTTP+WebSocket 服务，用系统默认浏览器打开 |
| **Nolanguage (Desktop)** | `Nolanguage.exe` | 用系统 WebView 引擎开一个无边框原生窗（零依赖，见报告 §3.9） |

> `dist/Nolanguage.exe` 是 Node SEA 单文件、自带运行时，双击即开 workspace；`--open-browser` 只是把它从"原生窗"切换成"浏览器"渲染。
>
> **没有控制台窗口**：`scripts/build-exe.mjs` 会把 SEA 的 PE 头 `Subsystem` 从 3（console）改成 2（GUI），否则每台机器双击都会先弹一个黑色命令框。安装器本身也是 NSIS 的 GUI 程序，同样没有控制台。

---

## 方式零：图形安装包 `Nolanguage-Setup.exe`（推荐）

`Nolanguage-Setup.exe`（约 22 MiB，NSIS）是标准 Windows 安装向导：

1. **欢迎页** —— 产品名与版本
2. **选择安装位置** —— 默认 `%LOCALAPPDATA%\Programs\Nolanguage`，可浏览或直接输入，选择会被记住（升级时沿用上次目录）
3. **安装进度** —— 进度条 + 实时日志（正在解压 / 正在写快捷方式 / 正在写注册表）
4. **完成页** —— 可勾选"运行 Nolanguage (Desktop)"

安装内容：`Nolanguage.exe`、`uninstall.exe`，开始菜单「Nolanguage」「Nolanguage (Web)」「Uninstall Nolanguage」，桌面快捷方式，以及 `HKCU` 卸载项（`DisplayIcon` / `EstimatedSize` / `QuietUninstallString`，设置 → 应用 里可正常卸载）。全程无需管理员权限。

**重新构建**：

```bash
npm run build:exe                 # 先确保 dist/Nolanguage.exe 是最新的
npm run build:setup               # → installer/Nolanguage-Setup.exe
```

`build-setup.mjs` 会自动找 `makensis`（`%NSIS_MAKENSIS%` → Tauri CLI 自带的 `%LOCALAPPDATA%\tauri\NSIS` → `PATH` → `C:\Program Files (x86)\NSIS`），所以只要跑过一次 `npm run tauri build` 就无需另外安装 NSIS。

静默安装（CI / 脚本）：`Nolanguage-Setup.exe /S /D=C:\path\to\dir`（`/D` 必须是最后一个参数）。

卸载：设置 → 应用 → Nolanguage，或安装目录里的 `uninstall.exe`。卸载会结束正在运行的应用、删除程序文件与快捷方式、清理注册表；安装目录里的用户数据（`.nolanguage`，含 WebView 配置与遥测数据库）会保留。

## 方式一：PowerShell 安装器（无需任何工具链，立即可用）

`setup.ps1` 不依赖 NSIS，只要一台 Windows + PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File installer/setup.ps1
```

它会把**同目录下的 `Nolanguage.exe`** 拷到 `%LOCALAPPDATA%\Programs\Nolanguage`，创建同样的开始菜单快捷方式、桌面快捷方式、卸载项。若同目录还有 `uninstaller.exe`，会一并装成 `uninstall.exe` 并让注册表指向它；没有则回退生成 `uninstall.ps1`。

**分发方式**：把 `setup.ps1` 和重新构建好的 `Nolanguage.exe` 放进同一个文件夹，把这个文件夹发出去即可。构建 exe：`npm run build:exe`（→ `dist/Nolanguage.exe`），再拷到 `installer/` 或任意同目录。

卸载：开始菜单"Uninstall Nolanguage"，或运行安装目录里的 `uninstall.ps1`。

---

## 构建单机 exe（两种方式都依赖它）

```bash
npm run build:exe     # → dist\Nolanguage.exe（Node SEA，自带运行时，GUI 子系统）
```

随后：

- 图形安装包（方式零）：`npm run build:setup` 重建 `installer/Nolanguage-Setup.exe`。
- PowerShell 方式：把 `dist/Nolanguage.exe` 复制到 `setup.ps1` 同目录。

> 想要 Tauri 原生壳（Rust 窗 + Node sidecar）的安装包，见 `npm run tauri build`（产物在 `src-tauri/target/release/bundle/`）。它的 sidecar 就是同一份 GUI 子系统的 `Nolanguage.exe`，所以也不会弹控制台。

## CLI 对应命令

开发/命令行下，等价的两个入口是：

```bash
nlg web            # 启动服务并用默认浏览器打开
nlg desktop        # 启动服务并开原生 WebView 窗
nlg web --no-open  # 仅启动服务（CI / 无头）
```
