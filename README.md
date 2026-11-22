# dsh-channel-telegram

把 **DeepSeek Harness** 接进 Telegram 的通道插件：在 Telegram 里发一条消息，就是一个跑在你本机 harness 里的任务。

它不是"再起一个子进程跑 SDK"，而是**进程内的 Cordis 插件**——挂进某个 profile 后，直接复用该 profile 的 `agents` / `sessions` 服务，所以你看到的会话、权限、模型路由、工具和 Web GUI 里完全一致。

```text
Telegram  ──长轮询──▶  channel-telegram (插件)
                              │  ctx.agents.create / followup
                              ▼
                       Harness Agent ──▶ 工具（bash / fs / web …）
                              │  session/event
                              ▼
                       回复文本 ──▶ Telegram
```

## 特性

- **一对一映射**：一个 Telegram chat = 一个 Harness Session（`tg:<chatId>`），重启进程会自动 `resume`，对话不断。
- **串行队列**：同一个 chat 的多条消息按顺序执行，不会互相打断。
- **只回文本**：模型 reasoning / thinking 块不会漏到聊天窗口，只发送 `text` 块。
- **白名单兜底**：未配置白名单直接拒绝启动；陌生账号发消息会被拒绝。
- **命令**：`/new` 开新会话、`/status` 看模型与工作目录、`/help` 说明。
- **零额外依赖**：只用 Node 内置 `fetch`，不需要 grammY / telegraf 之类的库。

## 安装

插件装进 profile（不污染全局）：

```bash
# 从 npm（发布后）
dsh plugin --profile tg add dsh-channel-telegram

# 从本仓库
dsh plugin --profile tg add github:yhc3577/dsh-channel-telegram

# 本地目录（开发用）
dsh plugin --profile tg add /path/to/dsh-channel-telegram
```

然后在 `~/.dsh/profiles/tg/cordis.patch.yml` 里挂载，参考 [`examples/cordis.patch.example.yml`](examples/cordis.patch.example.yml)：

```yaml
- id: channel-telegram
  name: dsh-channel-telegram
  config:
    botToken: "123456:ABCDEF..."
    allowedChatIds: ["8637406466"]
    provider: deepseek-official
    model: deepseek-flash
    cwd: /data/code/playground
```

启动：

```bash
dsh tg
```

国内直连 `api.telegram.org` 基本不可达。两种办法：

```yaml
# 推荐：写进插件配置，插件自己开启 fetch 代理
config:
  proxy: http://127.0.0.1:7890
```

```bash
# 或者让宿主进程整体走代理
NODE_OPTIONS=--use-env-proxy HTTPS_PROXY=http://127.0.0.1:7890 dsh tg
```

> 注意：`proxy` 是进程级开关（Node 的 fetch 只认进程环境变量），宿主进程里其它 `fetch` 也会走同一个代理。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `botToken` | 必填 | BotFather 的 token |
| `apiBase` | `https://api.telegram.org` | 换成自建 Bot API server 时用 |
| `allowedChatIds` | `[]` | 允许的 chat id 字符串列表 |
| `allowedUserIds` | `[]` | 允许的 user id，与 chat 白名单取并集 |
| `allowAllChats` | `false` | 显式放开白名单（仅限本地一次性测试） |
| `provider` | `deepseek-official` | 会话使用的 LLM provider |
| `model` | `deepseek-flash` | 会话使用的 model |
| `reasoningEffort` | 空 | 透传给模型路由 |
| `cwd` | 进程 cwd | Agent 的工作目录，必须已存在 |
| `pollTimeoutSeconds` | `30` | getUpdates 长轮询超时 |
| `maxMessageChars` | `4000` | 长回复按行拆分发送的上限 |
| `proxy` | 空 | 如 `http://127.0.0.1:7890`。插件会在首次请求前为本进程补上 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY`，因此**不需要**带 `--use-env-proxy` 启动宿主 |

## 权限

插件本身**不设置任何权限**，也拿不到权限决定权——它创建的 Agent 完全继承部署 profile 的策略：

- `sandbox-policy.mode`（`read-only` / `workspace-write` / `danger-full-access`）
- `approval.policy`（`ask` / `never`）

也就是说：想让 bot 能改文件、跑命令，是在 profile 里把 sandbox 调宽，而不是在插件里开开关。这样 Web GUI 里同一个会话的权限与 Telegram 侧永远一致。

> ⚠️ 一旦 profile 是 `danger-full-access` + `approval.policy: never`，任何在白名单里的人发消息就等于在你机器上跑命令。白名单务必只放自己的账号。

## 命令

| 命令 | 行为 |
|---|---|
| `/start`、`/help` | 通道说明 |
| `/new` | 轮换 Session id，开一段干净历史 |
| `/status` | 当前 session id、模型、cwd、agent 状态 |

## 限制

- 只处理文本消息；图片/语音/文件会被忽略（后续可以走 attachment seam）。
- 只支持私聊；群组消息直接拒绝（避免多人群聊里误触发本机命令）。
- 同一 bot token 只能有一个轮询者：**不要**同时让本插件和别的 gateway（例如 OpenClaw、另一个机器人的桥接）用同一个 token，否则互相 `409 Conflict`。
- 长回复按 4000 字符切分，Telegram 侧会看到多条消息。

## 开发

纯 ESM、无构建步骤、无运行时依赖：

```bash
npm test                 # 7 个 node:test 用例，覆盖 Config 校验与默认值
npm run check            # node --check lib/index.js
# 装到测试 profile 后先看组合结果，再启动：
dsh --profile tg --dump-config | grep -n -A8 channel-telegram
```

代码结构就一个文件 [`lib/index.js`](lib/index.js)：

- `Config`：schemastery schema，决定 profile 里的 YAML 写法；
- `apply(ctx, config)`：校验配置 → 建 Agent 映射 → 启动长轮询 → `ctx.on('session/event')` 收集回答；
- `ctx.effect(() => …)`：返回清理函数，profile 卸载时中止轮询并停掉 typing 定时器。

## License

MIT
