/**
 * Telegram adapter — stub for kithkit core.
 *
 * Agent-specific repos provide the real implementation via extension override.
 * This stub exists so the comms extension compiles without a Telegram dependency.
 */

import type { ChannelAdapter } from '../../comms/adapter.js';

export interface TelegramAdapterConfig {
  bot_token: string;
  safe_senders: Array<{ chat_id: number; name: string }>;
  poll_interval_ms?: number;
  max_message_length?: number;
}

export interface CommsTelegramAdapter extends ChannelAdapter {
  shutdown(): Promise<void>;
}

/**
 * Creates a Telegram polling adapter.
 *
 * In the public kithkit core this is a no-op stub that logs a warning.
 * Agent-specific repos (KKit-BMO, KKit-Skippy, etc.) replace this
 * with a real implementation.
 */
export async function createCommsTelegramAdapter(
  _config: TelegramAdapterConfig,
): Promise<CommsTelegramAdapter> {
  throw new Error(
    'Telegram adapter not available — provide an implementation in your agent repo extension.',
  );
}
