# 池化语言服务管理器（`LspManager`）

**0.7.24** · 语言无关核心 + manifest 驱动的插件。管理器负责池化、路由、调度、降级、增量失效和版本校验；语言知识全部下沉到插件（在本产品里就是一份 JSON）。

---

## 一、现有模块 → 新框架落点

先说清一件事：**这份设计里的 Rust 部分没有照字面实现。** 产品是 TypeScript 内核 + SEA 单文件（`dist/Nolanguage.exe`，85 MB，零第三方运行时依赖），`src-tauri/` 只有 457 行外壳且**不随产品分发**（WebView2 143 上原生窗口仍不可用）。把管理器写成 Rust crate 会得到一个装在别的进程里、和面板之间还要再造一层 IPC、并且需要 Rust 工具链才能构建的东西——而它管理的 `LspClient`、`check` 端点、Problems 面板全在 TypeScript 里。

所以按**接口等价**实现：`trait` → `interface`，`&'static str` → 冻结字段，`inventory` 编译期注册 → 静态表 + 注册表扫描，`Arc<Mutex>` → Node 单线程事件循环（"锁"就是那张 in-flight 表）。设计文档里的每条行为要求都保留了，并且都有门禁。

| 现有模块 | 角色 | 新框架落点 |
|---|---|---|
| `src/lsp/LspClient.ts` | 一个进程、一次握手、一组请求 | 复用，只加三处：`initializationOptions` 透传、`onId` 回调、`cancelRequest` |
| `src/lsp/jsonrpc.ts` | 帧 + 请求表 | 加 `$/cancelRequest` 与 `request(method, params, onId)` |
| `src/lsp/navigation.ts` | `NavResult` / 归一化 / 能力判定 | 复用，`format` 已在 `NavFeature` 里 |
| `src/langs/Registry.ts` | 插件清单与生命周期 | 复用，成为管理器的插件来源 |
| `src/langs/serverInstall.ts` | 发现 + 托管安装 | 复用，`resolveServer` 决定 `{resolved}` |
| `src/langs/manifest.ts` | manifest schema | **新增 `lsp.manager` 等字段**（见第三节） |
| `src/panel/WorkspaceService.ts` | slot / 缓冲 / 请求入口 | 只改三处：构造管理器、`startLsp` 委托、`release` 时释放池 |
| `src/panel/handlers/*` | WebSocket 端点 | **未改**——`slot.lsp` 换成接口后请求路径不变 |
| `scripts/verify-langs-exe.ts` | 「没装服务时说得清」 | 未改，仍全绿 |

`slot.lsp` 的类型从 `LspClient` 换成 `LspLike`（`src/lsp/lspLike.ts`）。`LspClient` 与 `ManagedLsp` 都结构满足它，所以**面板里没有一行 `if (manager)`**——这是这次改造能保持可逆的关键。

## 二、新增模块

| 文件 | 层 | 职责 |
|---|---|---|
| `src/lsp/manager/types.ts` | 6 | `LanguagePlugin` / `FallbackProvider` / `IncrementalStrategy` / `IndexMetadata` / `LspServerConfig` |
| `src/lsp/manager/PluginRegistry.ts` | 6 | 注册与路由；同扩展名按 `serverPriority` 再按 id 决定，结果确定 |
| `src/lsp/manager/LspPool.ts` | 6 | 按 `(plugin, project_root)` 池化、根收敛、空闲回收、取消转发 |
| `src/lsp/manager/ManagedLsp.ts` | 6 | 一个池化条目：懒启动、预算内降级、`LspLike` 实现 |
| `src/lsp/manager/Scheduler.ts` | 6 | latest-only + 单调序号 + 去重 + `$/cancelRequest` |
| `src/lsp/manager/CacheValidator.ts` | 6 | 版本签名校验、`<home>/index/<id>.json` 持久化 |
| `src/lsp/manager/signature.ts` | 6 | 签名 = 服务器版本 + 协议 + schema + 工具链 |
| `src/lsp/manager/strategies.ts` | 6 | `GitDiffStrategy` / `ContentHashStrategy` / `resolveDirty` 链 |
| `src/lsp/manager/fallback.ts` | 6 | `LexicalFallback`（词法级，数据驱动）+ `scanText` |
| `src/lsp/manager/DiagnosticsBuffer.ts` | 6 | 去重 + 每文件 2000 / 全局 12000 上限 |
| `src/langs/managerPlugins.ts` | 7 | manifest → `LanguagePlugin`；项目根、启动模板、签名 |
| `src/langs/lspLaunch.ts` | 7 | 启动策略（池化 / 旧路径），从 `WorkspaceService` 拆出 |
| `src/lsp/lspLike.ts` | 6 | 面板实际用到的那部分 LSP 表面 |

`langs` 在第 7 层、`lsp` 在第 6 层，所以「同时认识 manifest 和 LSP」的代码只能待在 `langs`。`lspLaunch.ts` 因此用结构化的 `LaunchSlot` 而不是导入 `Slot`——反向 import 会让层序变成环。

## 三、插件声明（全部是 manifest 字段）

```json
"lsp": {
  "manager": true,
  "projectMarkers": ["pom.xml", "build.gradle", "settings.gradle"],
  "command": ["{toolchain}", "-Xmx2G", "-XX:+UseG1GC",
              "-jar", "{glob:{dist}/plugins/org.eclipse.equinox.launcher_*.jar}",
              "-configuration", "{dist}/config_{platform}", "-data", "{dataDir}"],
  "initializationOptions": { "settings": {
    "java.import.mode": "ondemand",
    "java.jdt.ls.vmargs": "-Xmx2G -XX:+UseG1GC",
    "java.configuration.updateBuildConfiguration": "disabled" } },
  "idleTtlMs": 1800000, "firstRequestBudgetMs": 500, "navBudgetMs": 5000,
  "incremental": "git",
  "fallback": { "keywords": ["..."], "types": ["..."],
                "declarationPattern": "(?:class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)" }
}
```

**为什么需要 `command` 模板。** jdtls 的 `bin/jdtls.bat` 在本机是 `python jdtls %*` 加一行 `pause`——spawn 它会永久阻塞。真正的服务器是 `java -jar …/equinox.launcher_*.jar`。所以「用发现的二进制启动」这个假设在真实世界里不成立，模板是必需品而不是灵活性。占位符：`{resolved}` `{dist}` `{toolchain}` `{root}` `{dataDir}` `{platform}` `{glob:…}`。

**为什么 `projectMarkers` 取最外层。** Maven reactor 根和每个 module 都有 `pom.xml`。取最近的那个会让每个 module 各起一个 JVM——正是「进程爆炸」。取 `.git` 边界内最外层的 marker，一个仓库一个服务器；两个独立 checkout 仍是两个。

## 四、关键行为与实现要点

| 要求 | 实现 |
|---|---|
| 懒启动 | `acquire()` 只查表建对象，`ready()` 才 spawn |
| 根收敛 | `containsRoot(entry.root, root)` 命中即复用；反向不成立 |
| 并行冷启动 | 决策同步、spawn 异步；两种语言互不阻塞，无需锁 |
| 空闲回收 | 每插件 `idleTtlMs`，Java 30 分钟、默认 5 分钟 |
| latest-only | 每 `(client, method, uri)` 一个序号；新请求取消旧请求并转发 `$/cancelRequest` |
| 过期结果 | 序号不匹配即丢弃，返回空而不是旧值 |
| 去重 | 同参数的显式请求共享一个 Promise |
| 聚合 | `workspace/symbol` 向**已运行**的服务器广播后合并（不为一次搜索起八个进程） |
| 降级 | 启动超预算、请求超预算、`lspConfig` 为空 → fallback；UI 不等 |
| 诊断上限 | 去重后每文件 2000、全局 12000，按文件整块截断 |
| 版本校验 | 签名不符 → `rebuilt: true`，不读旧缓存 |

**请求预算的两种口径。** `firstRequestBudgetMs`（默认 500 ms）管"一次击键能等多久"：jdtls 导入 Maven 工程要 5 秒，等它等于卡死编辑器，所以先由词法兜底回答，服务就绪后自动切换。`navBudgetMs`（默认 5000 ms）管显式动作（定义、格式化、参数提示）——用户点了就愿意等，但不会无限等。

**失败启动的退避。** 30 秒内不重试。没有这个，一个坏掉的 jdtls 会按每个字符 spawn 一次。

## 五、测试

`npm run verify:lsp-manager`（见 `scripts/verify-lsp-manager.ts`）。断言总数会随每次改动变化，这里只列覆盖面：

- **纯逻辑**：路由（含优先级与 id 平局）、项目根（module → reactor、两个仓库两个根）、模板展开（`{glob:}` / `{platform}` / 缺 `{toolchain}` 时拒绝启动）、签名变更、git 与内容戳脏文件、阈值、诊断缓冲、词法扫描（字符串里的 `}` 不算失衡）、词法补全。
- **假服务器**（`scripts/fixtures/fake-lsp.mjs`，可配置延迟/诊断/拒绝启动，并记录收到的每个方法）：懒启动、根收敛、第二个根、空闲回收、latest-only（旧请求返回空、新请求有结果、`$/cancelRequest` 确实到达、丢弃计数）、去重（一次往返）。
- **真 jdtls**（缺失时 SKIP）：`initializationOptions` 三项、`initialize`、首次补全不超预算、导入完成后拿到 58 项 ArrayList 成员、热补全、hover、`publishDiagnostics`、嵌套根复用、一个根一个服务器。
- **stdio 测试服务**（`scripts/lsp-manager-service.ts`）：`open` / `completion` / `stats` / `shutdown` 四个往返，证明服务本身可用。

`npm test` 也增加了一组管理器单测，全部通过。注入验证：去掉 `$/cancelRequest` 转发 → latest-only 的取消断言失败；把 `versionSignature` 里的 `serverVersion` 固定 → 缓存失效断言失败。

## 六、性能基线（本机，jdtls snapshot + JDK 25）

| 指标 | 值 |
|---|---|
| 管理器路由 + 建条目（不 spawn） | < 1 ms |
| `initialize` 握手 | 2.6–2.9 s |
| 首次补全（预算内，走兜底） | 500–506 ms |
| 首次**真**补全（含 Maven 导入） | 4.9–5.2 s |
| 热补全 | 53–62 ms |
| 热 hover | < 50 ms |
| 第二根同项目复用 | 0 次 spawn |

冷启动的一次性成本几乎全在 jdtls 自己的导入上，管理器没有可测量的开销——`stats()` 里 `starts` 与实际 spawn 次数一致。

## 七、本轮不做（边界）

| 不做 | 原因 |
|---|---|
| Rust crate 版本 | 见第一节：产品是 TS/SEA，`src-tauri` 不随包分发 |
| tree-sitter 兜底 | 接口已留（`FallbackProvider.kind === 'tree-sitter'`），实现只到词法级 |
| 多客户端 mux | 单编辑器实例不需要 |
| 动态 `.so` 加载 | 编译期静态表 + manifest 扫描已够 |
| 自动下载 jdtls | 与 `nlg lang server` 的既有策略一致：github 类只打印指令 |
| 迁移其余七种语言 | 每种一行 `"manager": true`，但要逐个验；本轮只做 Java |
| 索引内容本身 | 管理器只管「什么时候该重建」，不拥有索引数据 |

## 八、后续

1. 给 pyright / gopls / tsserver 打开 `manager`，删掉旧路径（预计省 200 行）。
2. `ContentHashStrategy` 目前只在 `incremental: "content-hash"` 时记录 stamps；让 git 路径也顺带记一份，`.git` 丢失时不至于失去全部判据。
3. `symbols()` 只问已运行的服务器；如果面板要「全局符号」覆盖未启动语言，需要一个"按需启动并等待"的策略。
