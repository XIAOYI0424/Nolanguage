# AI 面板协议（0.7.24）

更新日期：2026-11-22

AI Assistant 从"HTML 壳 + 预设文本"变成了真正会发请求的面板，但范围故意收得很窄：**一次请求，
一个问题，一个答案，可取消**。本文记录帧格式、密钥位置和不做什么。

## 帧

客户端 → 引擎：

| kind | 字段 | 说明 |
| --- | --- | --- |
| `aiConfig` | — | 读配置。回答只含 `hasKey`，不含密钥 |
| `aiSetConfig` | `baseUrl`、`model`、`key?` | 校验并写入；`key: ""` 清除，省略则保留原值 |
| `aiAsk` | `requestId`、`prompt`、`language?` | 一次一个；已有答案在流式输出时拒绝 |
| `aiCancel` | `requestId` | 中止当前流，回的 `aiCancelled.ok` 表示是否真有东西在跑 |

引擎 → 客户端：

| kind | 字段 | 说明 |
| --- | --- | --- |
| `aiConfig` | `baseUrl`、`model`、`hasKey`、`error?` | 密钥永不回显 |
| `aiOut` | `requestId`、`text` | 增量文本，原样追加，不解析 HTML |
| `aiDone` | `requestId`、`ok`、`ms`、`bytes`、`error?` | 每条流**恰好**结束一次 |
| `aiCancelled` | `requestId`、`ok` | 对 `aiCancel` 的应答 |

## 配置与密钥

- 协议是 OpenAI 兼容的 `POST <baseUrl>/chat/completions`，`stream: true`，只读
  `choices[0].delta.content`。
- `baseUrl` 必须是 http(s)，且不能带用户名/密码（避免密钥有两个家）；`model` 限定
  `[\w.:@/-]`，最长 120。
- 密钥写在 `<appData>/ai.json`（`%LOCALAPPDATA%\Nolanguage\ai.json`，0600），**不进**
  页面 localStorage。页面里 `#aiKey` 是 `type=password`，保存后立即清空，任何重绘都拿不回它。
- 日志只记 `{requestId, ms, bytes, ok, status}`。提示词、答案、密钥都不进日志——日志是持久化
  且全文本可检索的，写进去就等于留下。

## 明确不做

- 不做多轮会话状态：每次 `aiAsk` 是一个独立请求，历史只存在于面板的文本里。
- 不做代码库索引/工具调用：面板不把工作区内容自动上传，只发用户输入的那段问题。
- 不做密钥代理转发：没有第二种出站 HTTP 通道，只有这一个 `node:https` 请求。

## 验证

- `npm run verify:ai`：本地回环 SSE 服务器覆盖三条流（正常、HTTP 401、取消），并断言任何一帧都
  不含密钥。
- `npm run verify:ui`：面板与抽屉的请求路径、密码框类型、`aiDone` 后 Stop 复位、错误可见。
- 单元测试覆盖 `normalizeBaseUrl` / `normalizeModel` / `buildChatRequest` / `SseDecoder`。
