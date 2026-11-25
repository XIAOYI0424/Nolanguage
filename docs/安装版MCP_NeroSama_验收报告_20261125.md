# 安装版 MCP 打开并运行 NeroSama 验收报告

> 报告日期：2026-11-25
> 被测程序：`D:\Nolanguage\Nolanguage.exe`
> 目标项目：`D:\15936\Documents\NeroSama`
> 依据方案：[测试方案_20261125.md](./测试方案_20261125.md) 中“真实项目只读验收”场景

## 1. 结论

**通过。** 安装版 Nolanguage 通过自身内置 MCP 面板和面板协议命令打开并读取了 `NeroSama`，发现并选中了项目本地虚拟环境，使用该环境的解释器执行了项目中的 `utils.py`，并得到真实输出 `13`。

测试前后对 `NeroSama` 的 **9,975** 个文件做了相对路径、大小和 SHA-256 清单对比：

```text
before=9975
after=9975
differences=0
```

目标项目在本次测试中未被新增、删除、重命名或修改任何文件。

## 2. 被测对象与环境

| 项目 | 值 |
|---|---|
| 安装版位置 | `D:\Nolanguage\Nolanguage.exe` |
| 可执行文件 SHA-256 | `9AEC2D35B033391B4BB4950F6B59E3B6B601DCB39A7840287AE770AD89DCA4C1` |
| 文件大小 | 89,664,000 bytes |
| 应用版本 | `0.7.24-workspace` |
| 面板端口 | 63496（运行时动态分配） |
| 目标项目 | `D:\15936\Documents\NeroSama` |
| 目标解释器 | `D:\15936\Documents\NeroSama\.venv\Scripts\python.exe` |
| 解释器版本 | Python 3.14.2（`.venv`） |
| 运行时间 | 2026-11-25 09:34:54（本地时间） |

安装版可执行文件哈希与当前构建 sidecar 哈希一致，说明测试对象就是已构建的安装版本，而不是源码树中的另一份程序。

## 3. 方法与边界

本次测试**没有直接调用** `python.exe`、`pip`、`go`、`npx` 或任何 shell 命令。测试驱动程序只启动安装版 `Nolanguage.exe`，随后所有项目操作都使用该程序自己的命令通道：

- 内置 MCP 面板：`mcpList` → `mcpConnect` → `mcpCall` → `mcpDisconnect`。
- 项目/编辑器命令：`openFolder`、`fsList`、`fsRead`、`interpreters`、`setInterpreter`、`run`。

为了使用内置 MCP 面板，提供了一份本地 stdio MCP 配置。该工具服务器只暴露两个**只读**工具：`list_project` 和 `read_project_file`，并拒绝访问目标根目录之外的路径。工具服务器、配置、应用数据和运行会话全部写在 `D:\15936\Documents\Nolanguage\.tmp\` 下，目标项目内没有写入。

需要说明：Nolanguage 的内置 MCP 是**工具调用面板**，项目打开动作本身仍是应用自己的 `openFolder` 命令；本次测试按此真实边界执行，没有把 MCP 面板描述成文件管理器。

## 4. 执行结果

自动化验收共 15 项，**15/15 通过**。

| 阶段 | 结果 | 关键证据 |
|---|---|---|
| 启动安装版 | PASS | `/health` 返回 `0.7.24-workspace`；版本、PID (`16728`) 和 exe 路径一致 |
| IDE 连接 | PASS | 面板 WebSocket 握手成功，端口 `63496` |
| MCP 配置加载 | PASS | 安装版读取 `mcp.json`，识别 `nerosama-readonly` |
| MCP 连接与工具发现 | PASS | 状态 `ready`，工具为 `list_project`、`read_project_file` |
| MCP 列目录 | PASS | 返回 `.idea`、`.obsidian`、`.venv`、`README.md`、`utils.py`、`vtuber`、`逻辑文档` 等 |
| MCP 读文件 | PASS | `utils.py` 读取 543 字节，内容包含 `maximumTotalDamage` |
| 打开项目 | PASS | `openFolder` 回执根为 `D:\15936\Documents\NeroSama` |
| 项目树 | PASS | `fsList` 返回真实项目条目；`.venv`、`.idea` 按项目树规则不展开 |
| 编辑器读取 | PASS | `fsRead utils.py` 返回 543 字节，语言识别为 `python` |
| 解释器发现 | PASS | 4 个候选中包含 `.venv\Scripts\python.exe`，版本 3.14.2，来源 `.venv` |
| 解释器选择 | PASS | `setInterpreter` 成功，工具链来源为 `override` |
| 内置运行器 smoke | PASS | 内存代码 `print("NLG_INSTALLED_RUN_OK")` 退出码 0，输出正确，用时 217 ms |
| 实际项目文件运行 | PASS | `utils.py` 退出码 0，stdout 为 `13`，stderr 为空，用时 226 ms |
| 再次确认真实文件 | PASS | 运行内容来自 `fsRead` 的 `utils.py` 字符串，不是替代样例 |
| MCP 断开 | PASS | 服务器状态回到 `idle` |

服务端日志进一步确认：两次运行都在 `Nolanguage` 的临时 app-home 下创建 session/snippet，使用的命令是目标项目 `.venv` 中的 Python，而不是测试脚本直接启动的解释器。

## 5. 实际项目内容运行详情

通过 `fsRead` 读取 `utils.py` 后，将得到的字符串作为 `run` 请求的 `code` 发送给安装版运行器：

```text
命令通道：run
language：python
sessionId：nerosama-acceptance-file
退出码：0
stdout：13
stderr：（空）
耗时：226 ms
解释器：D:\15936\Documents\NeroSama\.venv\Scripts\python.exe
```

`utils.py` 中调用 `maximumTotalDamage([1,6,6,7])` 并打印结果；本次真实执行输出为 `13`。这说明安装版运行器、项目本地 venv 自动匹配/选择和 Python 代码执行链路在该项目上闭环工作。

## 6. 只读保护证据

测试前生成基线：

```text
D:\15936\Documents\Nolanguage\.tmp\nerosama-before-acceptance.tsv
```

测试后生成对照：

```text
D:\15936\Documents\Nolanguage\.tmp\nerosama-after-acceptance.tsv
```

清单逐文件包含相对路径、字节大小和 SHA-256。`Compare-Object` 结果为 0 差异。

本次测试**没有执行**以下操作：`fsWrite`、`fsCreate`、`fsRename`、`fsDelete`、`applyWorkspaceEdits`、`envCreate`、`dependencyInstall`、`gitCommit`、`templatesGenerate`，也没有运行会在目标目录产生缓存/构建产物的项目级构建或测试命令。

## 7. 证据文件

| 文件 | 用途 |
|---|---|
| `.tmp/nerosama-mcp-test/results.json` | 15 项验收结果、原始回执和服务端日志尾部 |
| `.tmp/nerosama-mcp-test/mcp-server.cjs` | 本地只读 MCP stdio 工具服务器 |
| `.tmp/nerosama-mcp-test/acceptance.ts` | 验收驱动程序，只通过安装版 exe 的 MCP/协议通道操作 |
| `.tmp/nerosama-before-acceptance.tsv` | 测试前目标项目文件清单与哈希 |
| `.tmp/nerosama-after-acceptance.tsv` | 测试后目标项目文件清单与哈希 |

这些证据均在 Nolanguage 工作区的 `.tmp` 下，不在目标项目内。

## 8. 限制与说明

1. 本次只覆盖项目根目录列表、单个 Python 文件的读取与运行；没有运行 `vtuber/` 下的 Java/Go/Web/数据库子项目。
2. 内置 MCP 面板本次连接的是本地只读 fixture，而不是外部真实 MCP 服务；这是为了证明安装版 MCP 通道可用，同时保证目标项目零写入。
3. 未执行原生文件夹选择对话框和人工 UI 点击；打开项目使用的是应用协议中的 `openFolder` 命令。
4. 未安装任何依赖，未创建/修改虚拟环境；仅使用目标项目已有的 `.venv`。
5. 这是一次功能验收，不等于发布结论；发布仍要求干净工作树和符合流程的 tag。

## 9. 总体判定

安装版 Nolanguage 的内置 MCP 面板、项目打开、项目树、解释器自动匹配、本地 venv 运行器均按预期工作；目标项目内容得到真实执行结果；目标项目文件零变化。本次验收判定为 **PASS**。
