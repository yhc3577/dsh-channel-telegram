import type { Context } from '@deepseek-ai/cordis';

export interface Config {
  botToken: string;
  apiBase?: string;
  allowedChatIds?: string[];
  allowedUserIds?: string[];
  allowAllChats?: boolean;
  /** Set together with `model` to pin this channel to one model; omit both to follow the profile. */
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  /** Required: every Telegram Session needs an explicit working directory. */
  cwd: string;
  pollTimeoutSeconds?: number;
  maxMessageChars?: number;
}

export declare const name: 'channel-telegram';
export declare const inject: ['agents'];
/** Standard-Schema validator that fills defaults before `apply` runs. */
export declare const Config: {
  '~standard': {
    version: 1;
    vendor: 'dsh-channel-telegram';
    validate(value: unknown): { value: Config } | { issues: unknown[] };
  };
};
export declare function apply(ctx: Context, config: Config): void;
