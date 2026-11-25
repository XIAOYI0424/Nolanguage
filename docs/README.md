# docs 索引

这个目录放**现状、设计与指南**。代码怎么跑见根目录 `README.md`。

规则只有一条，而且是这份索引存在的原因：**现状只有一份，评估只做归档**。
`docs/archive/` 里那些按日期命名的文件描述的是"当时的样子"，它们不再更新，
也不应该被当成现在的样子读——每过一版就再写一份评估，正是它们不断被误读的原因。

## 现状

| 文档 | 内容 |
|---|---|
| [STATUS.md](./STATUS.md) | 能做什么、缺什么、明确的非目标；每条能力对应的门禁 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层、依赖方向、预算（文件行数、切片文件数）；数字由 `verify:arch` 校验 |

## 设计与决策

| 文档 | 内容 |
|---|---|
| [lsp-manager.md](./lsp-manager.md) | 池化语言服务管理器：为什么不是 Rust、现有模块落点、manifest 字段、测试与性能基线 |
| [测试方案_20261125.md](./测试方案_20261125.md) | 基于 0.7.24 实际代码链路的分层测试、用例、门禁及真实项目只读约束 |
| [安装版MCP_NeroSama_验收报告_20261125.md](./安装版MCP_NeroSama_验收报告_20261125.md) | 安装版通过内置 MCP/协议打开 NeroSama、运行实际文件并证明目标零改动的验收记录 |
| [project-wizard.md](./project-wizard.md) | 新项目向导：探测、脚手架与失败路径 |
| [ai-panel-protocol.md](./ai-panel-protocol.md) | AI 面板的帧协议、密钥落点与明确不做的部分 |

## 指南

| 文档 | 内容 |
|---|---|
| [添加新语言指南.md](./添加新语言指南.md) | 一门语言 = 一个目录 + 一份 manifest；先跑 `npm run scaffold:lang`，再按 §5 接线 |

## 归档（历史，不再更新）

每条都带归档日期，并把结论并入 [STATUS.md](./STATUS.md) 的"已知的差距"与"非目标"。

| 文档 | 当时评估的对象 |
|---|---|
| [archive/IDE差距评估_20261122.md](./archive/IDE差距评估_20261122.md) | 0.7.24 与 PyCharm / IntelliJ IDEA 的差距（其中 Test 树、内联提示、插件索引、AI 面板已落地） |
| [archive/补全与依赖修复方案_20261115.md](./archive/补全与依赖修复方案_20261115.md) | 补全与会话级依赖的修复方案 |
| [archive/LSP能力测试清单_20261114.md](./archive/LSP能力测试清单_20261114.md) | 逐项核对语言服务的实际能力 |
| [archive/评估_20261115.md](./archive/评估_20261115.md) | 0.7.9~0.7.10 的完整评估 |
| [archive/评估_20261110.md](./archive/评估_20261110.md) | 0.7.8：仓库完整性与评分 |
| [archive/评估_20261107.md](./archive/评估_20261107.md) | 0.7.7：三个"看起来有、实际不生效"的缺陷 |
| [archive/评估_20261102.md](./archive/评估_20261102.md) | 0.7.7 + ndebug |
| [archive/系统评估_20261027.md](./archive/系统评估_20261027.md) | 0.7.4：两个结构性 P0 |
| [archive/Tauri搁置说明.md](./archive/Tauri搁置说明.md) | 为什么放弃 Tauri 原生壳、什么条件下重新评估 |
| [archive/环境与包管理方案评审.md](./archive/环境与包管理方案评审.md) | 三层环境模型（工具链 / 项目环境 / 依赖） |
| [archive/新增语言与C-CMake评估.md](./archive/新增语言与C-CMake评估.md) | 编译型语言需要什么（含 CMake 路径） |

## 与调试观测台相关

- 设计：`debugtool/DESIGN.md`
- 使用：`debugtool/README.md`
- 代码：`src/debugtool/`
