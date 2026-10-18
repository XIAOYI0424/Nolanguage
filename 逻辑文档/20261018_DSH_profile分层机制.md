# DeepSeek Harness（dsh）· profile 分层插件机制

> 环境取样：本机 `D:\DSH`（Electron 应用，`dsh` 0.2.0-rc.2），`DSH_HOME` 未设时取 `%USERPROFILE%\.dsh`。
> 结论均来自实测：`dsh --help`、`dsh --profile web --dump-config`、`--dump-config-schema`、以及 profile 目录里的实际文件。

## 1. dsh 是什么

`dsh` 不是应用本体，而是**启动器 / 组装器**：它按 `profile` 把若干「插件包（bundle）补丁层」依次叠加，再叠上用

```
dsh [launcher 选项] <profile> [app 自己的参数...]
```

启动的是 profile 里声明的应用（web / desktop / tui / headless）。功能全部来自插件，启动器本身不认识任何业务。

实现方式（Windows）：`D:\DSH\resources\runtime\cli\bin\dsh.cmd`

```bat
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

即**复用 Electron 自带的 Node** 跑 CLI 脚本——用户机器上不需要另外装 Node。

## 2. 一个 profile 的磁盘布局

```
~/.dsh/
  profiles/
    web/
      cordis.yml          # profile 根：空 entry list，注释写明"改 patch，不要改我"
      cordis.patch.yml    # 用户层：唯一建议手写的文件
      package.json        # dsh.profile.bundles = 有序 bundle 名列表
      pnpm-lock.yaml      # 复现性
      node_modules/       # bundle 装在这里（pnpm）
    desktop/
```

`package.json` 的声明（实测）：

```json
{
  "name": "dsh-profile-web",
  "dependencies": { "MemOS": "git+...", "dsh-our-free-model": "^2.0.0", "dshmarket": "^1.66.15" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dshmarket",
    "dsh-our-free-model"
  ] } }
}
```

bundle 自己在 `package.json` 里声明补丁文件：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`dshmarket` 的补丁只有一条插入：

```yaml
- insert:
    - id: dsh-market
      name: 'dshmarket'
```

用户层 `cordis.patch.yml` 则是按 id 定向覆盖：

```yaml
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
```

## 3. 合成顺序（权威说法）

`--dump-config-schema` 的 `$comment` 原文：

> Bundle, profile, home, and CLI layers apply in that order. A patch config replaces the whole config.

即四层逐层叠加：**bundle 层 → profile 层 → home 层 → CLI 层（`--patch`）**。要点：

- patch 里的 `config` 是**整段替换**，不是深合并；
- 条目按 `id` 定位，可 `insert`、可 `disabled`、可覆盖 `name`/`config`/`inject`/`isolate`；
- 支持 `!!js` 表达式（如 `disabled: !!js '!ctx.get(''profileContext'')'`），运行时求值；
- 支持 `include`（子配置文件有自己的模块解析基址与补丁索引）；
- `--dump-config` 会把每层用 `# == @deepseek-ai/dsh-base` 这类注释分段打印出来，等于「启动原因的说明书」。

## 4. 命令面

| 命令 | 作用 |
|---|---|
| `dsh web` / `dsh desktop` / `dsh tui` | 启动对应 profile（等价 `dsh --profile web`） |
| `dsh headless "run the tests"` | 一次性任务：答完打印结果就退出 |
| `dsh --profile <name>` | 显式指定 profile |
| `dsh rescue --from-default-profile web` | 从内置模板新建一个自定义 profile 并启动 |
| `dsh --patch ./extra.yml` | 追加一层 CLI 补丁（可重复，最后生效） |
| `dsh --dump-config` | 打印合成后的完整配置树 |
| `dsh --dump-default-config` | 同上但去掉用户层与 `--patch` |
| `dsh --dump-config-schema` | 打印 profile/patch 的 JSON Schema |
| `dsh plugin --profile web add <pkg>` | 用 pnpm 往该 profile 装插件（其余 pnpm 参数原样透传） |
| `dsh tui --resume <session>` | launcher 之后的参数原样交给 app |

排查套路：改完 `cordis.patch.yml` 先 `dsh --profile web --dump-config`，确认目标条目确实被改写/插入，再启动。

## 5. 命令上 PATH 的做法（可迁移）

`resources/runtime/cli/command-manager.js` 管理 `dsh` 命令的安装/移除，值得抄的点：

- **所有权指纹**：目录里放 `.dsh-desktop-command.json`（schemaVersion + launcher 绝对路径 + 目标项指纹 + 可选备份文件名）；只有"当前项仍是自己装的那一份"才允许改，避免覆盖用户后来自建的 `dsh`；
- **可逆**：安装前把已存在的项 rename 成 `.dsh-command-backup-<uuid>`，卸载时原样恢复；指纹不符就保留备份并报 `ESTALE`/`EOWNERSHIP`；
- **原子写**：临时文件 + rename，Windows 对 `EACCES/EBUSY/EPERM` 做有界退避重试；跨进程写用 `<file>.lock` + PID 探活接管；
- 平台分支：macOS 用 `/usr/local/bin/dsh` 软链（必要时提权），Windows 交给 `command-path.ps1` 写用户 PATH。

## 6. 对 Nolanguage 的启示

| DSH 的做法 | Nolanguage 现状 | 可借鉴 |
|---|---|---|
| 启动器只做 YAML 分层求值，功能全在 bundle | 语言插件已做到 `manifest.json` 驱动；扩展插件靠 `EXT_DIR` 扫描 | 可以把「内置示例 / 用户插件 / CLI 覆盖」显式建模成有序层 |
| `--dump-config` 解释启动结果 | 无等价物 | 加 `--dump-plugins` 打印各 root 来源与胜出项 |
| `cordis.patch.yml` 是唯一用户可写文件，上游只读 | 用户改的是 `~/.nolanguage/languages` 里的整份插件 | 可引入「用户覆盖层」而不动插件本体 |
| CLI 复用 Electron 内置 Node，用户免装 Node | `nlg` 需要源码树 + Node | 可让 `Nolanguage.exe lang ...` 直接内建子命令 |
| 命令安装带指纹与备份，可逆 | setup 不写 PATH，`nlg` 装完不可用 | 抄 command-manager 的 receipt/backup 模型 |
