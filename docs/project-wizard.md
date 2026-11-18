# 项目向导：manifest 声明模板，UI 不认识任何语言

> 状态：P0 + 部分 P1 已实现（三栏、类型/语言/来源筛选、schema 表单、条件文件、目标目录校验、
> 文件模板、导入现有项目）。外部 provider（Initializr / cookiecutter / cargo-generate）尚未
> 接入——它们的**形状**已经定好。

## 一、为什么是三栏

IDEA 的生成器是「左侧选类别，右侧配参数」。Nolanguage 多一层：模板来源是聚合的
（内置 / Initializr / cookiecutter），同一语言下会有多个 provider 的多个模板。全塞进一列，
语言和来源的层级会打架。所以每一列只回答一个问题：

| 列 | 问题 | 数据来源 |
|---|---|---|
| 左 | 新建项目还是单个文件、哪门语言、哪个来源 | `TemplateSummary.kind` / `.language` / `.source` |
| 中 | 哪个模板 | `TemplateSummary[]` |
| 右 | 这个模板要什么参数 | `TemplateSummary.params`（schema） |

## 二、数据在哪

模板写在**语言 manifest** 里（`scaffold.templates`），不是 UI 里，也不是某个 provider 的
硬编码表里：

```json
"scaffold": {
  "templates": [{
    "id": "package", "name": "Python 包（src 布局）", "kind": "project",
    "suggestedDir": "{{name}}",
    "params": [
      { "key": "name", "label": "包名", "kind": "text", "required": true,
        "pattern": "^[a-zA-Z_][a-zA-Z0-9_-]*$", "hint": "…", "group": "项目坐标" },
      { "key": "python", "label": "Python 版本", "kind": "select", "default": "3.12",
        "options": [{ "value": "3.11", "label": "3.11" }], "group": "技术栈" }
    ],
    "files": [
      { "path": "pyproject.toml", "template": "…{{name}}…" },
      { "path": "tests/test_main.py", "when": "withTests", "template": "…" }
    ]
  }]
}
```

`kind` 支持 `text | select | boolean | multiselect`；`when` 指向一个 boolean 参数，为 false 时
该文件不写。**加一个模板 = 改 manifest，UI 一行不动。**

## 二点五、两种模板：`project` 与 `file`

同一个 registry、同一套 schema，区别只在 `kind` 和「写到哪」：

| | `project` | `file` |
|---|---|---|
| 目标 | 一个目录（工作区根 + 子目录） | 工作区根，路径由模板自己带 |
| 例子 | `pyproject.toml` + `src/…` | `tests/test_{{name}}.py` |
| 按钮 | 创建 | 创建文件 |
| 生成后 | 打开资源管理器 | 直接打开那个文件 |

文件模板的**子目录写在路径里**（`tests/test_x.py`），所以表单只需要问文件名，底部位置条就是
工作区根——不再多一个「放到哪个目录」的决策。左侧「类型」筛选就是 `kind` 的过滤。

## 二点七、导入现有项目（Ctrl+Alt+O）

文件已经存在，所以这不是向导：选一个目录，看它下面有哪些项目标记，把资源管理器切过去。

- 只看**当前目录 + 一层子目录**：深扫一个 home 目录又慢又不准，答案几乎总在隔壁；
- 跳过 `node_modules` / `target` / `dist` / `build` / `.venv` 等，它们不是项目根；
- 标记表是数据（`Cargo.toml`→rust、`package.json`→javascript、`pyproject.toml`/`setup.py`→
  python、`go.mod`→go、`pom.xml`→java、`CMakeLists.txt`→cpp），显示名优先从文件里读
  （`name` / `module` / `<artifactId>`），读不到就用目录名；
- **语言没装也能打开**：它只是一个目录，能看文件。

打开 = 现有的 `openFolder`（`fs.setRoot`）。所以这个功能没有新的写入路径，只有新的**发现**路径。

## 三、代码分层

| 文件 | 职责 |
|---|---|
| `src/scaffold/types.ts` | 参数类型、`expand()`、`resolveParams()`、`safeRelativePath()` |
| `src/scaffold/registry.ts` | 聚合、可用性、目录规则、写文件 |
| `src/langs/templateRegistry.ts` | 把 manifest 列表变成 registry（唯一知道 manifest 带模板的地方） |
| `src/panel/server.ts` | 两个命令的翻译层（帧 ↔ 调用），不新增文件 |
| `src/ui/client/69-wizard.js` | 三栏 UI；不包含任何语言知识 |
| `src/langs/manifest.ts` | 装载时校验模板声明 |

装载时就校验，而不是等用户点「创建」：`{{key}}` 引用了未声明的参数、`select` 没有 options、
`when` 指向非 boolean、id 重复——这些在安装插件时就报错，写模板的人立刻知道。

## 四、目录与参数规则（服务端强制，UI 只是提前提示）

- 目标必须是绝对路径，不能是磁盘根；
- 目录非空时拒绝，除非显式 `allowNonEmpty`（UI 上是一个复选框）；
- 文件路径不接受 `..`、盘符、绝对路径；写之前再算一次 `relative()`，防止符号链接父目录逃逸；
- 参数只保留 schema 声明过的键：provider 不会收到它没要的字段；
- 未知占位符是错误，不是空串——静默替换成空会生成一个「看起来对」的错误项目。

## 五、可用性与降级

不可用的模板**不隐藏**，置灰并写明原因（`TemplateSummary.reason`）。隐藏它等于告诉用户
「这里本来就没有 Java 模板」，而真实原因是「jdtls 没装」——和 LSP 管理器里 SKIP 必须归因
是同一条原则。

## 六、验证

| 层 | 位置 |
|---|---|
| 单元 | `tests/pure.test.ts`：展开、条件文件、pattern、非空目录、路径逃逸、不可用模板仍列出、文件模板只写一个文件 |
| 端到端 | CDP 冒烟：Ctrl+Alt+N → 选卡片 → 创建 → 文件出现在工作区；文件模式 7 张卡片筛到 3 张，生成 `main_test.go` |
| 架构 | `scaffold` 层 = 3，只能被更高层引用 |

## 七、还没做

- 外部 provider 的 `availability()`（检查命令/网络）与真正的 `generate()` 调用；
- 依赖多选的分组 UI（schema 已支持 `options[].group`，UI 目前平铺）；
- 「在工作区内新建子项目」与「新建工作区」的模式切换（现在统一用工作区根 + 子目录）。
