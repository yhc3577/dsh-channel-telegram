# 用户手册：在 Telegram 里用 DeepSeek Harness

这份手册面向**使用者**：怎么装、怎么配、怎么日常用、坏了怎么查。
想改代码或了解实现，请看 [README](../README.md)。

---

## 1. 它是什么

装好之后，你在 Telegram 里给 bot 发一条消息，等于在本机 harness 里开了一个任务：

```text
Telegram  ──长轮询──▶  channel-telegram（进程内插件）
                              │  ctx.agents.create / followup
                              ▼
                       Harness Agent ──▶ 工具（bash / 文件 / 搜索 …）
                              │  session/event
                              ▼
                       回复文本 ──▶ Telegram
```

三个要点：

1. **不是另起一个进程**。插件挂在你现有 profile 里，用的是同一套会话、权限、模型和工具；
2. **一个私聊 = 一个会话**，你在 GUI 里也能看到这些会话；
3. **权限就是 profile 的权限**，插件不开任何后门。

---

## 2. 前置条件

| 需要 | 说明 |
|---|---|
| DeepSeek Harness | `dsh` 命令可用（本手册按 Web profile 写法，其它 profile 同理） |
| 一个 Telegram bot | 找 [@BotFather](https://t.me/BotFather) 发 `/newbot`，拿到 `123456:ABC...` 形式的 token |
| 网络 | 能访问 `api.telegram.org`；境内一般需要本地代理（如 `http://127.0.0.1:7890`） |
| 你的 Telegram id | 私聊里发一条消息给 bot 后可从日志看；常见做法是用 `getUpdates` 查 `chat.id` |

---

## 3. 五分钟上手

### 3.1 装进 profile

```bash
# 从 GitHub（推荐，锁定 commit 才不会漂移）
dsh plugin --profile web add "github:yhc3577/dsh-channel-telegram#657afca"

# 或从本地目录（改代码时用，装成 link）
dsh plugin --profile web add /path/to/dsh-channel-telegram
```

`web` 换成你自己的 profile 名即可；`dsh plugin` 只改 profile 自己的依赖，不动全局环境。

### 3.2 写配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，**末尾追加**（新条目必须写在 `- insert:` 下面，
直接写 `- id:` 会被判成「未知条目」）：

```yaml
- insert:
    - id: channel-telegram
      name: dsh-channel-telegram
      config:
        botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        allowedChatIds: ["<你的 chat id>"]
        cwd: /data/code/notes          # 必填：bot 在这个目录里干活
        proxy: http://127.0.0.1:7890   # 境内需要；插件自带隧道，不用改宿主启动参数
```

模型**不用写**——默认跟随 profile 的 `agent-default-model`（第 5 节）。

### 3.3 生效

| 你的宿主 | 做法 |
|---|---|
| systemd 托管的 Web profile | `systemctl --user restart dsh-web.service` |
| 手动 `dsh web` / `dsh tg` | 直接重启进程（或让 HMR 自行重挂载配置） |

> HMR 能热替换**配置**，但**换不了模块代码**：`dsh plugin add` 升级补丁后要重启一次服务，
> 否则跑的还是旧代码。

### 3.4 验证

先确认 bot 身份对得上：

```bash
curl -sS --proxy http://127.0.0.1:7890 \
  "https://api.telegram.org/bot<token>/getMe"
```

然后**用你自己的账号**私聊 bot 发一句「你好」。约几秒内会看到「正在输入…」和回复。
没反应就跳到第 8 节排错。

---

## 4. 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `botToken` | 必填 | BotFather 给的 token |
| `apiBase` | `https://api.telegram.org` | 自建 Bot API server 时替换 |
| `allowedChatIds` | `[]` | 允许的 chat id（字符串数组，超大整数用引号） |
| `allowedUserIds` | `[]` | 允许的 user id，与 chat id 取并集 |
| `allowAllChats` | `false` | 临时放开白名单，**只建议排查时短暂打开** |
| `provider` | 空 | 与 `model` 一起写才有意义（见第 5 节） |
| `model` | 空 | 同上 |
| `reasoningEffort` | 空 | 需同时配 `provider`/`model` |
| `cwd` | **必填** | agent 的工作目录，必须是已存在的绝对路径 |
| `pollTimeoutSeconds` | `30` | getUpdates 长轮询超时时长 |
| `maxMessageChars` | `4000` | 长回复按行拆分发送的字符上限 |
| `proxy` | 空 | 如 `http://127.0.0.1:7890`；插件自带 CONNECT 隧道 |

几条硬规则（写错会直接**拒绝加载**，日志里能看到原因）：

- `cwd` 缺失或目录不存在 → 拒绝启动。**不会**退回到宿主进程目录，避免会话落在 `/home/yhc`。
- 只写 `provider` 不写 `model`（或反之）→ 拒绝启动。
- 白名单三项全空且没开 `allowAllChats` → 拒绝启动（防止裸奔）。
- `botToken` 形态必须是 `数字:字符串`。

---

## 5. 模型：跟随 profile，不在插件里另立一份

插件**不定义默认模型**。省略 `provider` / `model` 时，它运行时读取 profile 的
`agent-default-model` 服务——和 Web GUI 用的是同一份配置：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: newapi
    model: DeepSeek-V4.1-Flash
```

- 想换模型 → 只改这一处，Telegram 侧下次新建会话自动跟进；
- 想让**这个通道**固定用别的模型 → 在插件配置里同时写 `provider` + `model`（这是覆盖，不是默认值）；
- 两边都没配 → 加载时报 `未配置 provider/model，本 profile 也没有 agent-default-model 服务`。

会话里真正下发的模型可以在会话日志里核对（见第 8.6 节）。

---

## 6. 权限

插件**不设置权限**，Agent 完全继承 profile：

- `sandbox-policy.mode` = `read-only` / `workspace-write` / `danger-full-access`
- `approval.policy`  = `ask` / `never`

> ⚠️ 若 profile 是 `danger-full-access` + approval `never`，白名单里任何人发消息 = 在你机器上直接跑命令。
> 白名单只放自己，别把 bot 拉进群、别把 token 发给别人。

---

## 7. 日常使用

| 操作 | 行为 |
|---|---|
| 直接发文字 | 一个任务，回复里是最终文本 |
| `/start`、`/help` | 通道说明 |
| `/new` | 轮换会话 id（`telegram:<chatId>#<n>-<时间戳>`），开一段干净历史 |
| `/status` | 当前 session id、模型、cwd、agent 状态 |
| 连发多条 | 同一 chat 串行排队，不会互相打断 |
| 长任务 | 会持续「正在输入…」，完成后一次性发文本 |

行为约定：

- **只处理文本**；图片、语音、文件目前忽略。
- **只支持私聊**；群组消息会回「目前只支持私聊」。
- 非白名单账号会收到「这个 bot 未对你的账号开放」。
- 回复只发模型产出的文本，reasoning/thinking 不会漏到聊天窗口。
- 长回复按 4000 字符切分，会看到多条消息。

---

## 8. 排错手册

### 8.1 完全没反应（连"未开放/只支持私聊"都没有）

按顺序查：

1. **消息真的到 Telegram 了吗**——查待投递数：
   ```bash
   curl -sS --proxy http://127.0.0.1:7890 "https://api.telegram.org/bot<token>/getWebhookInfo"
   ```
   `pending_update_count` 长期为 `0` 而你也确实发过消息 → 消息没到服务器（客户端网络/代理问题），与插件无关。
2. **bot token 是不是同一只**：`getMe` 看 `username` 是否是你私聊的那个。
3. **插件是否在轮询**：向同一 token 发一次 `getUpdates`，返回 `409 Conflict: terminated by other getUpdates request`
   说明**已有**一个轮询者（正常）；能正常返回 200 说明插件没在轮询。
4. **插件是否加载成功**：`dsh --profile web --dump-config` 里应能看到 `channel-telegram` 条目；
   启动日志里若有 `warning: 1 entry did not activate`，后面会跟原因（常见：cwd 不存在、provider/model 半配）。
5. **打开诊断日志**（需要重启宿主）：
   ```bash
   # systemd：加 drop-in
   systemctl --user edit dsh-web.service   # 加一行 Environment=DSH_CHANNEL_TELEGRAM_DEBUG=/tmp/dsh-channel-telegram.log
   systemctl --user restart dsh-web.service
   ```
   日志会按 `dispatch → runPrompt → create/resume → followup → turn/end → reply` 记录每一步。

### 8.2 `409 Conflict: terminated by other getUpdates request`

同一 bot token **只能有一个长轮询者**。典型冲突源：

- 以前搭的独立 bridge / 旧脚本仍在跑；
- 另一个 profile（例如测试用 profile）也挂了同一 token；
- OpenClaw 等 gateway 与它共用 token。

处理：留一个、停其它。`pgrep -af bot-token` 不一定有效，按进程/服务逐个确认更可靠。

### 8.3 收到「这个 bot 未对你的账号开放」

你用的账号 id 不在白名单。把 `chat.id` 加进 `allowedChatIds`（注意 YAML 用引号），
或临时 `allowAllChats: true` 定位身份后立刻改回。

### 8.4 收到「目前只支持私聊」

消息来自群组/频道。当前版本只支持私聊。

### 8.5 回复是 `⚠️ 本轮失败：prompt variable "{{model}}" has no value`

说明这个 profile 既没配 `agent-default-model`，插件配置里也没有显式模型。
二选一：补 profile 的 `agent-default-model` 条目，或在插件配置里同时写 `provider` + `model`。

### 8.6 想核对某条消息到底用了什么模型 / 有没有跑完

会话文件在 `~/.dsh/sessions/<cwd 编码>/<会话目录>/session.v4.jsonl.zstd`，解压后看：

- `session`：会话 id 与 cwd；
- `request/header`：本次实际下发的 `provider` / `model`；
- `turn/end`：`completed` 表示正常结束，`error` 时后面带原因。

```bash
f=~/.dsh/sessions/--data-code-notes--/telegram~003A8637406466/session.v4.jsonl.zstd
zstd -dc "$f" | grep -o '"type":"turn/end"[^}]*}'
```

### 8.7 会话 id 被占用（`already owned by an active write handle`）

harness 的会话 id 全局唯一。旧进程（旧 bridge、旧 profile）若还以写锁持有同名会话，
插件会**自动换一个新身份**并重试一次（日志里能看到 `minting a new one`），不需要你手工处理。
若反复发生，说明确实有另一个进程在跑（见 8.2）。

### 8.8 升级后行为没变

`dsh plugin add` 只换磁盘上的代码；运行中的宿主不会重载模块代码。
必须重启服务（第 3.3 节）。配置改动可以靠 HMR 热挂载，代码不行。

### 8.9 宿主要不要加 `--use-env-proxy` / `NODE_USE_ENV_PROXY`

**不需要**。插件用自己的 `http/https` + CONNECT 隧道走 `proxy` 配置。
Node 的 `fetch` 只在进程启动时读代理环境变量，长期运行的 Web 宿主里再设往往不生效，
这也是插件不用 `fetch` 的原因。

---

## 9. 升级 / 回滚 / 卸载

```bash
# 升级到某个 commit
dsh plugin --profile web add "github:yhc3577/dsh-channel-telegram#<new-sha>"
systemctl --user restart dsh-web.service

# 回滚：装回旧 commit 即可
dsh plugin --profile web add "github:yhc3577/dsh-channel-telegram#<old-sha>"
systemctl --user restart dsh-web.service

# 卸载
dsh plugin --profile web remove dsh-channel-telegram
# 再删掉 cordis.patch.yml 里那段 insert，然后重启
```

改 patch 前建议先备份：

```bash
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)
```

---

## 10. FAQ

**会影响 Web GUI 吗？** 不会。两个入口共用会话与权限，只是多了一个发起方。

**能多人共用吗？** 可以，把他们的 chat id 加进白名单；但每个人 = 一个独立会话、同一份 profile 权限。

**能发图片/文件吗？** 当前版本只处理文本。

**token 放 YAML 里安全吗？** `cordis.patch.yml` 是本机文件（建议 `chmod 600`）。
更稳妥的做法是让 profile 从环境变量取 token，别提交进 git 仓库。

**一个 chat 能换模型吗？** 会话创建时就定了路由。想换：改 profile 默认模型 + `/new`，
或在插件配置里固定另一组 `provider`/`model` 后重启。
