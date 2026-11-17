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
| `src/langs/toolchainEnv.ts` | 7 | 把语言工具链目录前插到服务器 PATH（gopls 需要 `go`） |
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
  "freshDataDir": true,
  "incremental": "git",
  "fallback": { "keywords": ["..."], "types": ["..."],
                "declarationPattern": "(?:class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)" }
}
```

**为什么需要 `command` 模板。** jdtls 的 `bin/jdtls.bat` 在本机是 `python jdtls %*` 加一行 `pause`——spawn 它会永久阻塞。真正的服务器是 `java -jar …/equinox.launcher_*.jar`。所以「用发现的二进制启动」这个假设在真实世界里不成立，模板是必需品而不是灵活性。占位符：`{resolved}` `{dist}` `{toolchain}` `{root}` `{dataDir}` `{rootHash}` `{platform}` `{glob:…}`。

**`{dataDir}` 是按根分配的，而且 jdtls 每次都从空的开始。** 这一条是踩出来的，不是设计出来的：

1. `{dataDir}` 原本是 `<home>/lsp-data/<plugin>`，**一个插件一份**。jdtls 把 Eclipse workspace 放在 `-data` 下，两个项目共用一个时，第二个 jdtls **握手成功、然后永远不导入工程**——每个请求返回空，没有任何报错。语义基线里 java 就这样从 58 项变成 0 项。
2. 改成按根哈希分目录后，**同一个项目重开**仍然会坏：第二次启动一样是「握手成功、什么都不答」。`-Dosgi.locking=none` 没用，`LspClient.stop()` 先 kill 再等也没用（现在是先等 1.5 s 让它自己退，退不掉才 kill——这本身也是修掉的一个缺陷）。

所以最终是：`{dataDir}` 由适配器按根分配（`lsp-data/<plugin>/<rootHash>`），插件的 `lsp.freshDataDir: true` 在每次启动前清空它。目录数量有界（一个根一个），启动永远从已知状态开始。**代价是每次启动都要重新导入工程**（小 pom 2–5 s），换来的是「第二次打开不会得到一个哑掉的服务器」——对 jdtls 23.1 在本机的表现，这个交换是值得的。

`{rootHash}` 仍然可用（模板里能引用），只是默认已经体现在 `{dataDir}` 里了。

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

三个套件，按「确定性 → 真实性」排列。断言总数会随每次改动变化，这里只列覆盖面。

**1. `npm run verify:lsp-protocol`**（`scripts/verify-lsp-protocol.ts`）——不依赖任何真实服务器。

假服务器 `scripts/fixtures/fake-lsp.mjs` 可以延迟、拒绝启动、**对指定方法永不回答**（`--hang <method>`）、**在收到指定方法时直接退出**（`--die-on <method>`）、把 `initialize` 的 options 写进日志（`--log-init`），并记录收到的每个方法。于是每条断言都是关于管理器的决策：

| 场景 | 断言 |
|---|---|
| 连击（5 次补全） | 5 个请求都到达服务器、4 个被 `$/cancelRequest` 取消、只有 1 个带结果、丢弃计数 = 4 |
| 去重（3 次相同定义） | 1 次往返 |
| 超时（补全永不回答） | 407 ms 内返回兜底结果（预算 400），不挂起 |
| 超时（显式动作） | `unsupported` 且原因含 "timed out"，309 ms 返回 |
| 崩溃（请求途中退出） | 请求 12 ms 内落定（reject，不挂）、进程存活、条目报 `exited (code 7)`、后续请求走兜底、**不按请求重启**（initialize 次数不变） |
| 能力契约 | 声明了 `completionProvider` 就能答；`documentFormattingProvider: false` 时返回 `does not advertise format`，不是空列表 |
| `initializationOptions` | 真的到达服务器（日志里能看到 JSON） |

**这里有一条是「记录现状」而不是「断言好」**：产品**没有发送侧 debounce**。每次触发都发一个请求，客户端先用本地 L1 列表顶上，管理器负责取消上一个。上面那条「5 次请求、4 次取消」就是这个设计的成本，写成断言是为了让将来的改动可见——真要加 debounce 是产品决策（每次补全多 50 ms 延迟），不是补一个 bug。

**2. `npm run verify:lsp-manager`**（`scripts/verify-lsp-manager.ts`）——管理器本体 + 真 jdtls。

- 纯逻辑：路由（含优先级与 id 平局）、项目根（module → reactor、两个仓库两个根）、模板展开（`{glob:}` / `{platform}` / 缺 `{toolchain}` 时拒绝启动）、签名变更、git 与内容戳脏文件、阈值、诊断缓冲、词法扫描。
- 假服务器：懒启动、根收敛、第二个根、空闲回收、latest-only、去重。
- 真 jdtls（缺失时 SKIP）：`initializationOptions` 三项、`initialize`、hover、`publishDiagnostics`、嵌套根复用、一个根一个服务器。
- **冷启动降级**：第二个根没有热服务器，第一次击键 504 ms 返回 90 项**兜底**结果（`App` / `String` / `System`…），jdtls 导入完成后 4849 ms 起真成员（`add(String)`…）接管。这条证明了 500 ms 预算真的在起作用——而不是「jdtls 恰好答得快」。
- **stdio 测试服务**（`scripts/lsp-manager-service.ts`）：`open` / `completion` / `stats` / `shutdown` 四个往返。

**3. `npm run verify:lsp-semantics`**（`scripts/verify-lsp-semantics.ts`）——语义基线，每种语言一份固定 fixture，三条断言都带具体期望值：

| 语言 | 补全必须含 | hover 必须含 | 诊断必须含 |
|---|---|---|---|
| python（pyright） | `print`（8 项） | `(function) def print` | `Expected parameter name` |
| python（内置 stub，未装 pyright 时） | `print`（30 项） | `builtin` | `SyntaxError` |
| go（gopls） | `Println`（`fmt.` → 29 项） | `func fmt.Println` | `undefined` |
| javascript（tsserver） | `filter`（23 项） | `number[]` | `Expression expected` |
| markdown（marksman） | `other.md` | —（marksman 没有链接 hover） | `non-existent document` |
| rust（rust-analyzer） | `as_bytes`（138 项） | `let s: String` | `mismatched types` |
| c（clangd） | `x` / `y`（结构体字段） | `Type: `struct P`` | `undeclared identifier` |
| cpp（clangd） | `x` / `y` | `Type: `P`` | `undeclared identifier` |
| java（jdtls） | `add(`（58 项） | `List<String> names` | `cannot be resolved` |

python 有两行，因为同一个语言可能由两种后端服务，它们对同一件事的措辞不同（pyright 说 `(function) def print`，stub 说 `builtin`）。断言写成「任一命中」，两条都是具体的，没有放宽成「非空即可」。

服务器没装的 SKIP，所以这组基线会随安装的服务变厚，而不是在某台机器上永远红。

`npm test` 另有管理器单测（路由、签名、缓冲、词法、调度、EPIPE、PATH 注入）。注入验证：去掉 `$/cancelRequest` 转发 → latest-only 断言失败；把 `versionSignature` 的 `serverVersion` 固定 → 缓存失效断言失败。

### 两个数字的来历（容易被误读）

**Go 的「3 项」不是质量问题。** 早期测启动时间时在 `fmt.Println("hi")` 的第 6 列补全，光标落在 `Println` **内部**，于是得到前缀过滤后的 3 项（`Print` / `Printf` / `Println`）。在 `fmt.` 之后（第 5 列）是 **29 项**：`Append` / `Appendf` / `Errorf` / `Fprint` / `Sprint`… 完整导出面。数字差 10 倍，原因只是光标位置。

**Python 的「30 项」是 stub 的天花板。** 对 `json.`、`str.`、`x.` 三个接收者补全，返回的是**完全相同的 30 个名字**（`Exception` / `False` / `None` / `True` / `TypeError` / `ValueError`…，即 `COMMON_ITEMS` + 内建名）。也就是说 stub **没有成员解析**——它不看点号左边是什么。这不是 bug，是「内置兜底服务器」的定义；装上 pyright 后同一位置会给出真正的成员。语义基线里 python 那条断言写的是 `print`，正是为了不假装它有成员解析。

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

### 八种语言的启动耗时（同一口径：spawn + initialize + initialized）

| 语言 | 服务 | `initialize` | 首次有结果的补全 |
|---|---|---|---|
| c / cpp | clangd | **81–88 ms** | 7–12 ms |
| rust | rust-analyzer | **77–93 ms** | 1032–1036 ms（索引期间会 1 ms 回空） |
| javascript | tsserver | 246–279 ms | 450–460 ms |
| python | pyright | 261–265 ms | 796 ms |
| go | gopls | 340–374 ms | 420–453 ms |
| markdown | marksman | 914–938 ms | 34 ms |
| java | jdtls | **2017–3392 ms** | 1535–1610 ms（小 pom；大 reactor 4–5 s） |

clangd 最快且几乎不用等（81 ms 起，7 ms 出结果）；marksman 慢在 .NET 启动（~930 ms），但一上来就能答（34 ms）。**没有一个语言的 `initialize` 与「首次有结果」是同一天平上的两件事**——rust 是启动最快、可用最晚的那个。

**「启动快」和「可用早」是两件事。** rust-analyzer 的 `initialize` 最快（77 ms），但第一次真正有内容的补全要等 1.0 s——期间它 1 ms 就回一个空列表。所以「首次补全」这一列量的是**等到有 items** 为止，否则会把「还在加载」记成「很快」。

### jdtls：模块数不是成本，固定启动才是

「大 reactor 会到 4–5 s」是一个关于**规模**的判断，所以用一个控制变量的代理实验去问：同一个
app 模块，配上 0 / 2 / 5 个兄弟模块（都是纯 Java、无外部依赖），**每次全新 Eclipse workspace**
（`-data` 指向新目录，否则复用会跳过导入），量到 `stable`（58 项）：

| 模块数 | `initialize` | 首次有内容 | `stable` | 项数 |
|---|---|---|---|---|
| 1 | 2740 ms | 5796 ms | **6966 ms** | 58 |
| 3 | 2391 ms | 5084 ms | **6294 ms** | 58 |
| 6 | 2434 ms | 5187 ms | **6492 ms** | 58 |

**模块数几乎不产生影响**：6 模块比 1 模块还略快（噪声内）。也就是说 6–7 s 里绝大部分是
**JVM + JDT LS 初始化 + 第一次语义请求**的固定成本，不是「项目有多大」。

这直接改变了结论的方向：如果成本是固定的，那么**该调的是生命周期**（`ondemand` 的 TTL——
让服务器跨编辑活着），而不是「索引固化」。**这个实验不能替代真实项目**：真实 reactor 的
时间很可能花在 Maven 依赖解析上，而那需要网络和真实依赖树，这里没有。代理实验能回答的只有
一个问题——「模块数本身是不是变量」——答案是**不是**。

### jdtls：模块数不是成本，固定启动才是

「大 reactor 会到 4–5 s」是一个关于**规模**的判断，所以用一个控制变量的代理实验去问：同一个
app 模块，配上 0 / 2 / 5 个兄弟模块（都是纯 Java、无外部依赖），**每次全新 Eclipse workspace**
（`-data` 指向新目录，否则复用会跳过导入），量到 `stable`（58 项）：

| 模块数 | `initialize` | 首次有内容 | `stable` | 项数 |
|---|---|---|---|---|
| 1 | 2740 ms | 5796 ms | **6966 ms** | 58 |
| 3 | 2391 ms | 5084 ms | **6294 ms** | 58 |
| 6 | 2434 ms | 5187 ms | **6492 ms** | 58 |

**模块数几乎不产生影响**：6 模块比 1 模块还略快（噪声内）。也就是说 6–7 s 里绝大部分是
**JVM + JDT LS 初始化 + 第一次语义请求**的固定成本，不是「项目有多大」。

这直接改变了结论的方向：如果成本是固定的，那么**该调的是生命周期**（`ondemand` 的 TTL——
让服务器跨编辑活着），而不是「索引固化」。**这个实验不能替代真实项目**：真实 reactor 的
时间很可能花在 Maven 依赖解析上，而那需要网络和真实依赖树，这里没有。代理实验能回答的只有
一个问题——「模块数本身是不是变量」——答案是**不是**。

### 试过但没采用的调优：`cachePriming.enable = false`

假设：关掉 rust-analyzer 的依赖缓存预热能缩短首次补全。**交替采样**（每次跑两个变体，共 4 轮，每次新项目 + 新服务器）的结果：

| 变体 | `initialize` | 首次补全（范围） | 中位数 |
|---|---|---|---|
| 默认 | 56–98 ms | 818–1057 ms | 1053 ms |
| `cachePriming.enable=false` | 55–68 ms | 820–1056 ms | 868 ms |

区间几乎完全重叠，差异落在噪声里。**没有改 manifest。** 第一轮不交替采样时看到过「1.9–4.9 s」，那是首跑冷盘的采样偏差——顺序会污染结果，所以结论来自交替采样。

**补测：用 `stable` 重做一次。** 上面量的是「首次有内容」（约 1 s），而用户真正等的是「答案完整」（138 项，约 4.7 s）——两个指标可能对 priming 的反应完全不同，所以这不是重复实验。同样的交替采样，3 轮，每次新项目 + **全新 `LOCALAPPDATA` 缓存**（强制重建索引），门禁的 `expectItems=138`：

| 变体 | `stable`（三轮） | 中位数 | 项数 |
|---|---|---|---|
| 默认 | 9727 / 8264 / 7870 ms | **8264 ms** | 138 |
| `cachePriming.enable=false` | 8802 / 8748 / 8880 ms | **8802 ms** | 144 |

默认反而快 6%，仍在噪声内。**结论不变：不改 manifest。** 顺带得到一个有用的事实：清空缓存后 `stable` 是 **7.9–9.7 s**，而基线里的 4.7–5.0 s 是**热缓存**下的数字——所以 `gateMs` 必须容得下「索引重建」这种情况，这也解释了为什么它被设成 15 s。

## 七、启动：谁在等，等多久

启动时的成本几乎全在「等一个语言服务」和「问每个工具链的版本」这两件事上，管理器本身仍然没有可测量开销。

### 7.1 `eager` 关掉之后：两段式

`builtin/python@1.0.0` 原本是唯一 `lsp.eager: true` 的语言，`workspace.init()` 会同步等它握手。关掉后 `init()` 从 **439–518 ms → 138–150 ms**，但第一次 Python 击键要自己付 pyright 的钱（约 1.0–2.3 s）。

所以 manifest 声明了 `bundledFallback` 且 `eager` 为假时走两段：

```
第一次击键 ──> 启动 stub（~400 ms）──> 回答（30 项）
                     │
                     └─ 300 ms 后 ──> 启动真服务 ──> 就绪后接管，停掉 stub
```

300 ms 的延迟不是随手写的：真服务在第一次击键的同一毫秒启动，会让那次击键和「本该躲开它的东西」抢 CPU。实测首次击键 **415–417 ms**（空载）／约 570–700 ms（宿主繁忙），随后 pyright 接管并给出 8 项成员。

**只有真服务存在时才分两层。** 如果解析结果本身就是 stub（没装 pyright），`launch` 就是 fallback，两段式会把它当"真服务"再起一次——多一个进程。`fromStub` 标记就是为了这个。

**击键不等，提问要等。** stub 没有 references、没有 quick fix，goto 只是文件内启发式。所以
会话第一秒里的 Ctrl+B / Alt+F7 / Alt+Enter 会得到「没找到」——用户问的是问题，不是要一次
击键。这类显式动作走 `waitForUpgrade`（上限 10 s），并提前放行那 300 ms 延迟
（`startUpgradeNow`）；补全与 hover 仍然由 stub 立刻回答，不等。

**导航结果里的 URI 只有一种形状。** pyright 返回 `file:///c%3A/tmp/a.py`（冒号编码、盘符
小写），bundled stub 返回 `file:///C:/tmp/a.py`。客户端把前者当路径用，会打开一个不存在的
文件而且不报错——跳转「什么也没发生」。`normalizeLocations` 统一成 `pathToFileURL(fileURLToPath(uri))`
的形式，`navOpen` 再兜一层 `decodeURIComponent`；`verify:lsp-protocol` 用假服务器钉住这条。

**接管要靠内容证明，不能靠状态字段。** 门禁对同一个位置做两次同样的请求：stub 的 `pri` 返回 30 项（`Exception` / `False` / `None`…）、hover 是 `**builtin** print`；接管后同一个 `pri` 返回 8 项（`copyright` / `StopIteration`…）、hover 是 `(function) def print(...)`。两条断言都要求**两个方向都有差异**（新增的候选、消失的候选），所以「`slot.lsp` 换成 pyright 了、但请求还落在 stub 上」这种 bug 会红。只断言 `serverName === 'pyright'` 的话，它永远不会红——用户会一直看到内置名补全，而 pyright 在后台空转。

### 7.2 版本探测：缓存 + 签名失效

`status()` 必须同步（UI 会轮询），所以版本在 `addSlot` 里就解析好——代价是每个语言一次 `--version` spawn（58–149 ms；九个 manifest 串行 607 ms）。

`src/langs/versionCache.ts` 把它变成缓存，键是**签名**：`sha256(路径 + size + mtime + 参数)`。

| 情况 | 行为 |
|---|---|
| 签名相同 | 直接返回，0 次 spawn |
| 二进制换了（升级） | 签名变 → 重探 |
| 参数换了（`--version` → `-V`） | 签名变 → 重探 |
| 探测失败 | **不缓存**，下次再试 |
| 文件损坏 / 不存在 | 当作空缓存，不影响启动 |

实测 `init()` **189 ms（冷缓存）→ 19–22 ms（命中）**。

### 7.3 基线：三个阈值，门禁只看 `stable`

`perf-baseline.json` 记录每个语言的 `handshakeMs` / `firstMs` / `stableMs`：

- **握手** = spawn + `initialize`。它随 JVM、磁盘、杀毒软件波动，**不作门禁**。
- **首次有内容** = 第一次非空补全。用户已经能用了，但可能只是一部分。
- **稳定** = 答案不再变化。**这是门禁看的那个数。**

rust-analyzer 是最好的例子：1.0 s 回 16 项，4.7 s 才到 138 项。用握手当门禁，等于用最不可控的数字去判断最需要控制的体验。

门禁 `npm run verify:startup`（`scripts/verify-startup.ts`）另外守着三件事：基线必须覆盖每个声明了服务的语言（加语言不写基线会红）、`python` 不得再 `eager`、首次 Python 击键必须由 stub 回答。宿主繁忙时绝对数字会整体漂移 2–4 倍，所以取**多次独立冷启动里最好的一次**；`java`（每次清空 Eclipse workspace）与 `rust`（每次重建索引）在基线里用显式 `gateMs` 表达它们的冷成本。

## 八、本轮不做（边界）

| 不做 | 原因 |
|---|---|
| Rust crate 版本 | 见第一节：产品是 TS/SEA，`src-tauri` 不随包分发 |
| tree-sitter 兜底 | 接口已留（`FallbackProvider.kind === 'tree-sitter'`），实现只到词法级 |
| 多客户端 mux | 单编辑器实例不需要 |
| 动态 `.so` 加载 | 编译期静态表 + manifest 扫描已够 |
| 自动下载 jdtls | 与 `nlg lang server` 的既有策略一致：github 类只打印指令 |
| 迁移其余七种语言 | 每种一行 `"manager": true`，但要逐个验；本轮只做 Java |
| 索引内容本身 | 管理器只管「什么时候该重建」，不拥有索引数据 |

## 九、TTL：把「重启多贵」和「闲置多久」分开量

`java` 是唯一走池化管理器的语言，它的 `idleTtlMs` 原来是默认的 **5 分钟**。这个数字对 clangd
（重启 86 ms）无所谓，对 jdtls（重启 6–7 s，见上一节）就是在反复交税。

### 9.1 现在的值：java 2 小时，其余 5 分钟

TTL 挂在 **manifest** 上（`lsp.idleTtlMs`），不是全局常量——因为两边差一个数量级：

| 语言 | 重启成本（`stable`） | TTL | 理由 |
|---|---|---|---|
| c / cpp | 0.5–1.3 s | 5 min（默认） | 重启便宜，占内存不值 |
| go / js / markdown / python | 1.2–2.0 s | 5 min（默认） | 同上 |
| rust | 4.7 s（热缓存） | 5 min（默认） | **候选上调**，但没走管理器，改了不生效 |
| **java** | **6.3–7.0 s** | **2 h** | 重启最贵，且真实使用里「改一会儿、停一会儿」是常态 |

2 小时是一个**保守的起始值**，不是结论——下面是拿结论的方法。

### 9.2 埋点：三个事件，够用

管理器在 `logs/app.log` 里写三条结构化记录（`LspManager`）：

| 事件 | 字段 | 回答什么 |
|---|---|---|
| `lsp.server.reused` | `language` / `idleMs` / `converged` | 服务器闲置多久之后又被需要 |
| `lsp.server.started` | `startMs` | 重启一次的真实代价 |
| `lsp.server.reaped` | `keys` | TTL 真的踢掉了谁 |

`npm run lsp:ttl` 读这份日志（默认 `~/.nolanguage/logs/app.log`，可传路径），输出每种语言的
reuse 次数、median / p90 / max 闲置时长、当前 TTL，以及一句判定：

- `ttl-is-generous`：**80% 的复用发生在 TTL 的 80% 以内** → TTL 在起作用，服务器还在。
- `ttl-is-tight`：复用时服务器已经不在了 → 该加长。
- `no-data`：没有样本就不猜——**从零个观测里编一个 TTL，是让 TTL 变成民间传说的方式。**

判定逻辑在 `src/lsp/ttlStats.ts`（纯函数，5 条单测），脚本只负责读日志和打印。

### 9.3 CM5 → CM6 的观察项

`verify:ui-live` 每次跑都会记录一行，**不参与判定**：

```
OBSERVE cm6-trigger · 100000 lines / 5277779 chars · setValue 30 ms · first keystroke 5 ms · 30 keystrokes 171 ms
```

触发条件是 **`setValue > 100 ms` 或单次击键 > 5 ms**。当前 100k 行是 **30 ms / 5.7 ms**——击键
这一项已经压在线上（500 行时是 1.0 ms），所以真正的结论是：**如果用户会打开十万行级别的文件，
CM6 已经不是「假设中的需要」，而是「刚好够用」。** 500 行的门禁是 `< 150 ms / 30 次`（现在 31 ms）。

## 九、后续

1. 给 pyright / gopls / tsserver 打开 `manager`，删掉旧路径（预计省 200 行）。
2. `ContentHashStrategy` 目前只在 `incremental: "content-hash"` 时记录 stamps；让 git 路径也顺带记一份，`.git` 丢失时不至于失去全部判据。
3. `symbols()` 只问已运行的服务器；如果面板要「全局符号」覆盖未启动语言，需要一个"按需启动并等待"的策略。
