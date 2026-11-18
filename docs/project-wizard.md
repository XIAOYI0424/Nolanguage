# 项目向导：manifest 声明模板，UI 不认识任何语言

> 状态：P0 + 部分 P1 已实现（三栏、类型/语言/来源筛选、schema 表单、条件文件、目标目录校验、
> 文件模板、导入现有项目、添加依赖、运行配置）。外部 provider（Initializr / cookiecutter /
> cargo-generate）尚未接入——它们的**形状**已经定好。

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

## 二点八、添加依赖（Ctrl+Alt+D）

不解析 lock 文件、不改版本号——那是工具链的事。这里只负责两件用户最容易做错的事：
**用哪个命令**、**在哪个目录**。

| 标记 | 命令 |
|---|---|
| `Cargo.toml` | `cargo add <spec>` |
| `go.mod` | `go get <spec>` |
| `pyproject.toml` | `uv add <spec>`（`pip install` 只改环境，不改项目声明） |
| `package.json` | `npm install <spec>` |

`<spec>` 在**任何进程启动之前**按白名单校验（`lodash`、`@scope/pkg@1.2`、`serde@1`、
`github.com/x/y@v1`）；空白和 shell 元字符一律拒绝——命令虽然不走 shell，但「看起来像第二个
参数」的输入不该有机会。失败不写盘：工具链失败时项目原样不动，输出原样展示。

## 二点九、运行配置（Ctrl+Alt+R）

四个字段：名称、程序参数、工作目录、环境变量。其余（解释器、超时、覆盖）都来自语言 manifest，
再存一份只会变旧。配置存 `<home>/run-configs.json`——**跟着用户走，不跟着项目走**。

接通过程里发现这条链有**三处断点**，都修了：

1. `RunRequest.args` 早就声明了，但 `WorkspaceService.run()` 不接受、也不转发；
2. `template` 运行时（Rust/Go/C 等）的 `steps.ts` 不把参数拼进 argv；
3. **`builtin/python@1.0.0/bootstrap.py` 把 `sys.argv` 重置成 `[source]`**——参数被它吞掉，
   而且这一处最隐蔽：前两处修完仍然是空。

现在的行为（实测）：`args: ['--x', 'a b']` → 程序里 `sys.argv[1:] == ['--x', 'a b']`；
`env: { NL_TEST: 'from-config' }` → `os.environ` 里可见。参数只加在**最后一个可运行步骤**上，
构建步骤（`go build`）不会被塞进用户参数。

### 9.1 `splitArgs` 的边界：只切分，不解释

| 输入 | 结果 | 为什么 |
|---|---|---|
| `--port 8080` | `['--port', '8080']` | 空白是分隔符 |
| `--msg "two words"` | `['--msg', 'two words']` | 引号保留空格 |
| `$HOME/x` | `['$HOME/x']` | **不展开变量**：程序收到字面量 |
| `*.py` | `['*.py']` | **不展开通配**：由程序决定 |
| `a && b` / `a; b` | `['a', '&&', 'b']` | **不解释操作符**：它们只是普通参数 |
| `$(rm -rf ~)` | 原样一个参数 | 同上 |

理由不是"少写代码"，是**边界**：参数最终交给 `spawn(command, argv, { shell: false })`，
不经过任何 shell。一个会展开 `$(…)`、`&&`、`*` 的"运行配置"就等于在这个边界上开了一个 shell——
那是安全漏洞，不是功能。用户要 shell 语义时应该写一个脚本，而不是在 IDE 的参数框里写。

代价是诚实的：`--file=$PWD/x` 不会按 shell 展开。这与 VS Code / JetBrains 的
"program arguments" 语义一致——它们同样不展开。

### 9.2 为什么 `run-configs.json` 跟着用户走

配置存在 `<home>/run-configs.json`（默认 `~/.nolanguage/`），**不**存在项目目录里：

- 同一个人会开很多项目，而"带 `--port 8080` 跑一遍"是这个人的习惯，不是某个仓库的属性；
- 项目目录是**可提交的**：把个人运行配置写进去，等于逼用户把它加进 `.gitignore`，或者更糟——
  提交一堆指向本机路径的 `cwd`；
- 解释器、超时、覆盖这些**跟项目走**的东西已经由语言 manifest 声明，不需要第二份。

反过来说，需要进仓库的配置（团队共享的启动命令）属于项目文件，不是这个存储——那是一个尚未做的
功能（`.nolanguage/run.json` 之类），不是把两种语义塞进一个文件。

### 9.3 不是每个运行时都能收参数

`RunRequest.args` 只有在**真进程**上才有意义。`RuntimeExtension.supportsArgs` 声明这件事：

| 运行时 | 收参数 | 原因 |
|---|---|---|
| `template`（c/cpp/java/rust） | 是 | 真进程，参数排在源文件之后 |
| `repl-session`（python） | 是 | 真进程，参数排在 bootstrap 之后 |
| `directory-session`（go） | 否 | 跑固定步骤列表，参数会落到 `go build` 上 |
| `inline-vm`（javascript） | 否 | 进程内求值，没有 argv |
| `script-host` | 否 | 入口脚本自己解析参数 |

对话框据此**停用**「程序参数」并写明原因，而不是收下一个会被丢弃的值；引擎再兜一层——收到
不支持的参数时记一条 `warn` 并丢弃（CLI 和旧页面都可能发）。两处声明与代码的一致性由
`verify:arch` 的 R8 强制（`docs/ARCHITECTURE.md`）。

### 9.4 一个只有真跑才会暴露的 bug：`Ctrl+Alt+R` 从来没到过编辑器

全局守卫为了拦浏览器刷新写的是 `e.ctrlKey && k === 'r'` ——**没有排除 Alt**，而它在捕获阶段
`stopPropagation()`。于是 `Ctrl+Alt+R` 被当成"浏览器刷新"吞掉，运行配置的快捷键一直不生效
（菜单项能开，所以手工点的时候看不出来）。修法是加 `!e.altKey`：拦刷新，不拦带 Alt 的组合键。

教训与 `verify:ui-live` 那 5 条红同源：**快捷键必须用真实按键验证，不能靠读代码**。

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
| 端到端 | CDP 冒烟：Ctrl+Alt+N → 选卡片 → 创建 → 文件出现在工作区；文件模式 7 张卡片筛到 3 张，生成 `main_test.go`；Ctrl+Alt+O 打开项目；Ctrl+Alt+D 识别 `cargo add` 并拒绝非法 spec |
| 架构 | `scaffold` 层 = 3，只能被更高层引用 |

## 七、还没做

- 外部 provider 的 `availability()`（检查命令/网络）与真正的 `generate()` 调用；
- 依赖多选的分组 UI（schema 已支持 `options[].group`，UI 目前平铺）；
- 「在工作区内新建子项目」与「新建工作区」的模式切换（现在统一用工作区根 + 子目录）。
