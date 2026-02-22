/**
 * Channel Adapter Interface — the contract all channel adapters must implement.
 *
 * Adapters handle outbound message delivery and inbound message reception
 * for a specific communication channel (Telegram, email, terminal, etc.).
 *
 * Verbosity levels control how messages are formatted per channel:
 *   - verbose: full detail, all context
 *   - normal: moderate detail (default)
 *   - headlines: summary/headline only
 */

// ── Types ────────────────────────────────────────────────────

export type Verbosity = 'verbose' | 'normal' | 'headlines';

export interface ChannelCapabilities {
  markdown: boolean;
  images: boolean;
  buttons: boolean;
  html: boolean;
  maxLength: number | null;
}

export interface OutboundMessage {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface InboundMessage {
  from: string;
  text: string;
  channel: string;
  metadata?: Record<string, unknown>;
  receivedAt: string;
}

/**
 * Channel adapter interface — all adapters must implement these 4 methods.
 */
export interface ChannelAdapter {
  /** Unique channel name (e.g., 'telegram', 'email', 'terminal') */
  readonly name: string;

  /** Send a message through this channel */
  send(message: OutboundMessage): Promise<boolean>;

  /** Receive inbound messages (pull model) */
  receive(): Promise<InboundMessage[]>;

  /** Format a message according to the channel's verbosity setting */
  formatMessage(text: string, verbosity: Verbosity): string;

  /** Report channel capabilities */
  capabilities(): ChannelCapabilities;
}
