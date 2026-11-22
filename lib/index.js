/**
 * dsh-channel-telegram — a Telegram channel plugin for DeepSeek Harness.
 *
 * Mounted inside a harness profile, this plugin owns a Telegram long-poll loop
 * and drives ordinary harness agents in-process: one chat maps to one Session,
 * every incoming text becomes a user message on that Session, and assistant
 * text is streamed back to the chat.
 *
 * It deliberately keeps the surface small:
 *   - only text messages are handled;
 *   - an allowlist is mandatory unless `allowAllChats` is set explicitly;
 *   - permissions (sandbox mode, approval policy) come from the deployment
 *     profile, never from this plugin.
 *
 * @module dsh-channel-telegram
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const name = 'channel-telegram';

/** Services required before `apply` runs. */
export const inject = ['agents'];

/**
 * Defaults applied to every absent field. Kept inline so the plugin stays
 * dependency-free: any profile can install it from a git URL without a
 * registry round-trip.
 */
const DEFAULTS = {
  apiBase: 'https://api.telegram.org',
  allowedChatIds: [],
  allowedUserIds: [],
  allowAllChats: false,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: '',
  cwd: '',
  pollTimeoutSeconds: 30,
  maxMessageChars: 4000,
};

const isStringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * Normalize raw profile YAML into the shape `apply` relies on.
 * @param raw - whatever the profile patch supplied.
 * @returns the config with every default filled in.
 */
function normalizeConfig(raw) {
  const config = {
    botToken: raw.botToken ?? '',
    apiBase: raw.apiBase ?? DEFAULTS.apiBase,
    allowedChatIds: raw.allowedChatIds ? [...raw.allowedChatIds] : DEFAULTS.allowedChatIds,
    allowedUserIds: raw.allowedUserIds ? [...raw.allowedUserIds] : DEFAULTS.allowedUserIds,
    allowAllChats: raw.allowAllChats === true,
    provider: raw.provider ?? DEFAULTS.provider,
    model: raw.model ?? DEFAULTS.model,
    reasoningEffort: raw.reasoningEffort ?? DEFAULTS.reasoningEffort,
    cwd: raw.cwd ?? DEFAULTS.cwd,
    pollTimeoutSeconds: raw.pollTimeoutSeconds ?? DEFAULTS.pollTimeoutSeconds,
    maxMessageChars: raw.maxMessageChars ?? DEFAULTS.maxMessageChars,
  };
  return Object.freeze(config);
}

/**
 * Standard-Schema config validator. Cordis calls `~standard.validate` before
 * `apply`, so shape errors surface as plugin-load failures instead of as a
 * half-started poll loop.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-channel-telegram',
    /**
     * @param value - raw patch config.
     * @returns `{ value }` with defaults, or `{ issues }` for a rejected shape.
     */
    validate(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'channel-telegram: config 必须是对象', path: [] }] };
      }
      const issues = [];
      if (typeof value.botToken !== 'string' || value.botToken === '') {
        issues.push({ message: 'botToken 必填，且必须是 BotFather token 字符串', path: ['botToken'] });
      }
      for (const key of ['allowedChatIds', 'allowedUserIds']) {
        if (value[key] !== undefined && !isStringArray(value[key])) {
          issues.push({ message: `${key} 必须是字符串数组（Telegram 的 id 会超出 JS 安全整数范围）`, path: [key] });
        }
      }
      if (value.allowAllChats !== undefined && typeof value.allowAllChats !== 'boolean') {
        issues.push({ message: 'allowAllChats 必须是布尔值', path: ['allowAllChats'] });
      }
      if (value.pollTimeoutSeconds !== undefined && !(typeof value.pollTimeoutSeconds === 'number' && value.pollTimeoutSeconds >= 1)) {
        issues.push({ message: 'pollTimeoutSeconds 必须是 >= 1 的数字', path: ['pollTimeoutSeconds'] });
      }
      if (value.maxMessageChars !== undefined && !(typeof value.maxMessageChars === 'number' && value.maxMessageChars >= 64)) {
        issues.push({ message: 'maxMessageChars 必须是 >= 64 的数字', path: ['maxMessageChars'] });
      }
      if (issues.length > 0) return { issues };
      return { value: normalizeConfig(value) };
    },
  },
};

const HELP_TEXT = [
  'Telegram ↔ DeepSeek Harness 通道已连接。',
  '',
  '直接发一条消息就是一个任务，Harness 会在 cwd 里执行并回复结果。',
  '',
  '命令：',
  '/new — 结束当前会话并开一个新会话',
  '/status — 查看当前会话、模型和工作目录',
  '/help — 显示这段说明',
].join('\n');

/** Split long replies on line boundaries so Telegram accepts every part. */
function splitMessage(text, limit) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Whether one allowlist entry matches an id. */
function listed(list, id) {
  return list.some((entry) => String(entry).trim() === String(id));
}

/**
 * Bind one Telegram Bot API method to a fetch call.
 * @param config - resolved plugin config.
 * @param signal - abort signal for shutdown.
 * @returns a caller for Bot API methods.
 */
function telegramClient(config, signal) {
  const call = async (method, payload) => {
    const response = await fetch(`${config.apiBase}/bot${config.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal,
    });
    const body = await response.json().catch(() => undefined);
    if (body?.ok !== true) {
      throw new Error(`Telegram ${method} 失败：${body?.description ?? `HTTP ${response.status}`}`);
    }
    return body.result;
  };

  const sendText = async (chatId, text) => {
    for (const part of splitMessage(text, config.maxMessageChars)) {
      await call('sendMessage', { chat_id: chatId, text: part });
    }
  };

  return { call, sendText };
}

/**
 * Install the Telegram channel: one poll loop plus one agent per chat.
 * @param ctx - harness context with the `agents` service.
 * @param config - resolved and schema-defaulted plugin config.
 */
export function apply(ctx, config) {
  const token = String(config.botToken ?? '').trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('channel-telegram: botToken 不是有效的 BotFather token');
  }
  if (!config.allowAllChats && config.allowedChatIds.length === 0 && config.allowedUserIds.length === 0) {
    throw new Error('channel-telegram: 必须配置 allowedChatIds 或 allowedUserIds；确认放开请显式设置 allowAllChats: true');
  }
  if (!Number.isFinite(config.pollTimeoutSeconds) || config.pollTimeoutSeconds < 1) {
    throw new Error('channel-telegram: pollTimeoutSeconds 必须是正数');
  }

  const cwd = resolve(config.cwd || process.cwd());
  if (!existsSync(cwd)) {
    throw new Error(`channel-telegram: cwd 不存在：${cwd}`);
  }

  const log = (message) => ctx.logger.info(message);
  const controller = new AbortController();
  const client = telegramClient(config, controller.signal);

  /** chat id → its Session/Agent and the reply buffer for the running turn. */
  const chats = new Map();
  /** live Session object → its chat state, for event routing. */
  const sessions = new WeakMap();

  let offset = 0;
  let disposed = false;

  const chatStateFor = (chatId) => {
    const existing = chats.get(chatId);
    if (existing) return existing;
    const fresh = {
      chatId,
      /** Bumped by /new; part of a fresh Session identity. */
      generation: 0,
      sessionId: `tg:${chatId}`,
      agent: undefined,
      opening: undefined,
      /** Serializes prompts for one chat so two messages never interleave. */
      chain: Promise.resolve(),
      buffer: [],
      typing: undefined,
      failure: undefined,
      /** Deferred resolved by the running turn's `turn/end`. */
      pending: undefined,
    };
    chats.set(chatId, fresh);
    return fresh;
  };

  const nextSessionId = (chat) => {
    chat.generation += 1;
    return `tg:${chat.chatId}#${chat.generation}-${Date.now()}`;
  };

  const agentOptions = () => ({
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  });

  /**
   * Reuse a live Agent for this Session, else create one, else resume the
   * persisted Session (first message after a restart lands here).
   */
  const openAgent = async (chat) => {
    const live = ctx.agents.get(chat.sessionId);
    if (live) return live;
    try {
      return await ctx.agents.create({
        sessionId: chat.sessionId,
        meta: { cwd },
        agentOptions: agentOptions(),
      });
    } catch (createError) {
      // A Session persisted by an earlier process cannot be created again:
      // resume it so a bot restart keeps the same conversation.
      try {
        return await ctx.agents.resume({
          resumeSessionId: chat.sessionId,
          agentOptions: agentOptions(),
        });
      } catch {
        throw createError;
      }
    }
  };

  const ensureAgent = async (chat) => {
    if (chat.agent) return chat.agent;
    if (!chat.opening) {
      chat.opening = openAgent(chat).then(
        (agent) => {
          chat.agent = agent;
          chat.opening = undefined;
          sessions.set(agent.session, chat);
          log(`[tg ${chat.chatId}] 会话已就绪：${chat.sessionId}`);
          return agent;
        },
        (error) => {
          chat.opening = undefined;
          throw error;
        },
      );
    }
    return chat.opening;
  };

  const startTyping = (chat) => {
    if (chat.typing !== undefined) return;
    const tick = () => {
      client.call('sendChatAction', { chat_id: chat.chatId, action: 'typing' }).catch(() => {});
    };
    tick();
    chat.typing = setInterval(tick, 4000);
  };

  const stopTyping = (chat) => {
    if (chat.typing === undefined) return;
    clearInterval(chat.typing);
    chat.typing = undefined;
  };

  /** One prompt → one reply, with the turn's assistant text buffered by events. */
  const runPrompt = async (chat, text) => {
    const agent = await ensureAgent(chat);
    chat.buffer = [];
    chat.failure = undefined;
    const done = Promise.withResolvers();
    chat.pending = done;
    startTyping(chat);
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
      const outcome = await done.promise;
      stopTyping(chat);
      const answer = chat.buffer.join('\n\n').trim();
      if (outcome === 'error' && !answer) {
        await client.sendText(chat.chatId, `⚠️ 本轮失败：${chat.failure ?? '未知错误'}`);
        return;
      }
      if (!answer) {
        await client.sendText(chat.chatId, `（本轮没有产出文本，结束原因：${outcome}）`);
        return;
      }
      await client.sendText(chat.chatId, answer);
    } catch (error) {
      stopTyping(chat);
      await client
        .sendText(chat.chatId, `⚠️ 处理失败：${error instanceof Error ? error.message : String(error)}`)
        .catch(() => {});
    } finally {
      chat.pending = undefined;
    }
  };

  const enqueue = (chat, text) => {
    chat.chain = chat.chain.then(() => runPrompt(chat, text)).catch((error) => {
      log(`[tg ${chat.chatId}] 队列异常：${error instanceof Error ? error.message : String(error)}`);
    });
    return chat.chain;
  };

  /** Handle one authorized message: commands locally, everything else as a task. */
  const handleMessage = async (chat, message) => {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) {
      await client.sendText(chat.chatId, '目前只支持文本消息。');
      return;
    }
    if (text === '/start' || text === '/help') {
      await client.sendText(chat.chatId, HELP_TEXT);
      return;
    }
    if (text === '/new') {
      // The previous Agent simply becomes idle: the harness reclaims it when
      // the profile unloads, and a fresh Session id starts a clean history.
      chat.agent = undefined;
      chat.sessionId = nextSessionId(chat);
      await client.sendText(chat.chatId, `已开启新会话：${chat.sessionId}`);
      return;
    }
    if (text === '/status') {
      await client.sendText(
        chat.chatId,
        [
          `会话：${chat.sessionId}`,
          `模型：${config.provider} / ${config.model}`,
          `工作目录：${cwd}`,
          `状态：${chat.agent ? chat.agent.status : '尚未创建'}`,
        ].join('\n'),
      );
      return;
    }
    log(`[tg ${chat.chatId}] 收到任务，长度 ${text.length}`);
    await enqueue(chat, text);
  };

  const dispatch = async (update) => {
    const message = update.message ?? update.edited_message;
    if (!message?.chat) return;
    const chatId = String(message.chat.id);
    const userId = String(message.from?.id ?? '');
    if (!config.allowAllChats && !listed(config.allowedChatIds, chatId) && !listed(config.allowedUserIds, userId)) {
      log(`[tg ${chatId}] 拒绝未授权用户 ${userId}`);
      await client.sendText(chatId, '这个 bot 未对你的账号开放。').catch(() => {});
      return;
    }
    const chat = chatStateFor(chatId);
    if (message.chat.type !== 'private') {
      await client.sendText(chatId, '目前只支持私聊。');
      return;
    }
    await handleMessage(chat, message);
  };

  /** Long-poll getUpdates until shutdown; back off instead of hammering. */
  const poll = async () => {
    let backoff = 1000;
    while (!disposed) {
      try {
        const updates = await client.call('getUpdates', {
          offset,
          timeout: config.pollTimeoutSeconds,
          allowed_updates: ['message'],
        });
        backoff = 1000;
        for (const update of updates ?? []) {
          offset = Math.max(offset, Number(update.update_id) + 1);
          void dispatch(update).catch((error) => log(`[tg] 处理更新失败：${String(error)}`));
        }
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        log(`[tg] 轮询失败：${message}；${Math.round(backoff / 1000)}s 后重试`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };

  ctx.effect(() => {
    const offEvent = ctx.on('session/event', (session, event) => {
      const chat = sessions.get(session);
      if (!chat?.pending) return;
      if (event.type === 'turn/start') {
        chat.buffer = [];
      } else if (event.type === 'assistant/message') {
        const blocks = event.data?.message?.content ?? [];
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string') chat.buffer.push(block.text);
        }
      } else if (event.type === 'turn/end') {
        const reason = event.data?.reason?.kind ?? 'completed';
        if (reason === 'error') chat.failure = event.data?.reason?.error?.message ?? '未知错误';
        chat.pending.resolve(reason);
      }
    });

    const offError = ctx.on('agent/error', ({ agent, error }) => {
      const chat = sessions.get(agent.session);
      if (chat?.pending) chat.failure = error?.message ?? String(error);
    });

    log(`Telegram 通道已启动：模型 ${config.provider}/${config.model}，工作目录 ${cwd}`);
    void poll();

    return () => {
      disposed = true;
      controller.abort();
      offEvent();
      offError();
      for (const chat of chats.values()) {
        stopTyping(chat);
        chat.pending?.resolve('disposed');
      }
    };
  });
}
