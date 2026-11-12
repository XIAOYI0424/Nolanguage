# Tauri 桌面壳：正式搁置（0.7.5）

> 判定日期 2026-10-27（0.7.5）  
> 结论：**不投入、不发布、代码保留**。桌面形态继续用 Edge `--app`（`src/desktop/WebViewHost.ts`）。
> 本文记录判定依据，以及将来什么条件下可以重新评估。

---

## 一、结论是怎么来的

不是"试了几次没成"，而是一次对照实验：

1. 真实壳（`src-tauri/target/release/nolanguage.exe`）启动后，`%LOCALAPPDATA%\Nolanguage\tauri-shell.log` 记录
   `page-load never finished within 20s`，同时**没有任何 `msedgewebview2.exe` 宿主进程**。
2. 这个现象无法区分两种原因：**(a) 我们的壳（窗口配置/IPC/hardening）** 还是 **(b) 这台机器的 WebView2 跑不起来**。
3. 于是写了 `src-tauri/examples/probe.rs`：一个 420×240 窗口、一条内联 `data:text/html,...`、**无 IPC、无自定义配置、无 hardening**。页面加载完成时写一个标记文件。
4. 探针结果：进程存活，**13 个 `msedgewebview2.exe` 宿主进程被拉起**，但**标记文件始终没有出现**——页面永远加载不完。
5. 加参数重试：`--disable-gpu`、`--no-sandbox`、`--disable-gpu --no-sandbox --disable-dev-shm-usage`，**全部失败**。

结论：**环境问题，不是壳的问题**。一个 20 行的 wry 程序都渲染不出页面，壳里改什么都无济于事。

## 二、根因：运行时 143，且改不动

- 本机 WebView2 **Evergreen Runtime = 143.0.3650.139**（`C:\Program Files (x86)\Microsoft\EdgeWebView\Application`，HKLM 注册项 `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`）。
- Edge 浏览器本身是 151，所以"WebView2 是 151"是错觉——那是 Edge 的 `EdgeCore`，不是运行时（`nlg doctor` 曾在 0.7.3 修过这个误报）。
- 尝试升级：
  - Evergreen bootstrapper（1.8 MiB）→ 退出码 `0x80040828`；
  - 离线独立安装包（204.9 MiB）→ 同样 `0x80040828`。
  - `MicrosoftEdgeUpdate.log` 的原话：`Failed to install [0x80040828] 安装失败。已为系统安装 Microsoft Edge Webview2 Runtime。`
- 当前会话 `admin=False`。机器级运行时**只能由管理员替换**，两个安装器都在"已存在系统级安装"这一步退出，不会降级/覆盖。

## 三、解除条件（任一即可）

1. **管理员权限升级 Evergreen 运行时**（推荐，一次性）：
   ```powershell
   # 管理员 PowerShell
   Start-Process "$env:TEMP\MicrosoftEdgeWebView2RuntimeInstallerX64.exe" -ArgumentList '/silent','/install' -Wait
   ```
   升级后跑一次 `nlg doctor`（应显示 > 143），再跑探针：
   ```powershell
   cd src-tauri
   cargo build --example probe --release
   target\release\examples\probe.exe D:\tmp\probe.txt
   ```
   标记文件出现 → 可以重新评估 Tauri；否则继续搁置。
2. **随包携带 fixed-version 运行时**：把 WebView2 固定版本运行时放进安装包，用
   `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 指过去。代价约 **+150 MB** 安装体积，且需要自己跟版本。
   只有在"必须不依赖系统 Edge"时才值得。

## 四、现在的桌面形态

- 窗口由 `msedge.exe --app=http://127.0.0.1:7310/` 打开（Edge 自己的新内核，工作正常）。
- 代价：依赖用户装了 Edge。Edge 被卸载或大版本更新可能影响（前者在启动时会回退到默认浏览器）。
- 已具备：启动版本握手（同构建复用 / 无窗口接管 / 异构建替换）、`nlg doctor` 五态诊断、安装回执、签名状态。

## 五、探针的维护

`src-tauri/examples/probe.rs` 保留在仓库里，它是**将来复评的第一个动作**：

```powershell
cd src-tauri
cargo build --example probe --release      # 约 1 分钟（依赖已编译）
target\release\examples\probe.exe <marker-file>
```

注意 `target/` 被 git 忽略，`cargo clean` 之后 `probe.exe` 会消失——重新 `cargo build` 即可，它不是产品入口。
