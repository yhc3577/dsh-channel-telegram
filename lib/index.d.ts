import type { Context } from '@deepseek-ai/cordis';

export interface Config {
  botToken: string;
  apiBase?: string;
  allowedChatIds?: string[];
  allowedUserIds?: string[];
  allowAllChats?: boolean;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  cwd?: string;
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
