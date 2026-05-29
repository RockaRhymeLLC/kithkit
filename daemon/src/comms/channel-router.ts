/**
 * Channel Router — manages multiple channel adapters and routes messages.
 *
 * Supports multi-channel delivery (send to multiple channels at once).
 * Each channel has its own verbosity setting. Inbound messages from
 * any channel can be collected and injected into the comms agent.
 *
 * Outbound gate: an optional approvalGate function can be registered via
 * registerOutboundGate(). When registered, it is called for each outbound
 * send BEFORE the adapter transport is called. If the gate returns false,
 * the send is aborted for that channel. The gate is channel-aware: channels
 * with no approval_policies entry pass through immediately.
 */

import type {
  ChannelAdapter,
  OutboundMessage,
  InboundMessage,
  Verbosity,
} from './adapter.js';

// ── Types ────────────────────────────────────────────────────

export interface OutboundGateContext {
  /** The adapter/channel name (e.g. 'telegram', 'm365-mail') */
  channel: string;
  /** Canonical recipient addresses — sourced from message.metadata.recipients if present */
  recipient: string[];
  /** The formatted message text (post-formatMessage, pre-send) — used for human-facing preview */
  content: string;
  /** The original message text before channel formatting — used for content_hash in the gate.
   *  Stable across channels so duplicate-detection works even when formatters differ. */
  rawContent: string;
  /** Agent name — sourced from message.metadata.sender_agent if present */
  sender_agent: string;
}

export type OutboundGateFn = (ctx: OutboundGateContext) => Promise<boolean>;

// ── State ────────────────────────────────────────────────────

const adapters = new Map<string, ChannelAdapter>();
const verbositySettings = new Map<string, Verbosity>();

/** Registered outbound gate — null means no gate (all sends pass through). */
let _outboundGate: OutboundGateFn | null = null;

// ── Public API ───────────────────────────────────────────────

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.name, adapter);
  if (!verbositySettings.has(adapter.name)) {
    verbositySettings.set(adapter.name, 'normal');
  }
}

/**
 * Unregister a channel adapter.
 */
export function unregisterAdapter(name: string): boolean {
  verbositySettings.delete(name);
  return adapters.delete(name);
}

/**
 * Get a registered adapter by name.
 *
 * @warning Calling adapter.send() directly on the returned adapter BYPASSES the
 * approval gate entirely. Extension-originated outbound sends MUST go through
 * {@link routeMessage} so the gate is applied. Only use the raw adapter for
 * non-gated operations (e.g. inbound polling, answerCallbackQuery, internal
 * status pings that are not human-facing message sends).
 */
export function getAdapter(name: string): ChannelAdapter | undefined {
  return adapters.get(name);
}

/**
 * List all registered adapter names.
 */
export function listAdapters(): string[] {
  return Array.from(adapters.keys());
}

/**
 * Register the outbound approval gate function.
 * Called once during daemon startup by the approval workflow initializer.
 * The gate is invoked for every outbound send; channels with no approval
 * policy entry pass through immediately (gate is a noop for those channels).
 */
export function registerOutboundGate(fn: OutboundGateFn): void {
  _outboundGate = fn;
}

/**
 * Set verbosity for a channel.
 */
export function setVerbosity(channel: string, verbosity: Verbosity): void {
  verbositySettings.set(channel, verbosity);
}

/**
 * Get verbosity for a channel.
 */
export function getVerbosity(channel: string): Verbosity {
  return verbositySettings.get(channel) ?? 'normal';
}

/**
 * Send a message through specified channels (or all if none specified).
 * Each channel formats the message according to its verbosity setting.
 *
 * If an outbound gate is registered (via registerOutboundGate()), it is
 * invoked for each target channel BEFORE the adapter transport is called.
 * Gate returning false aborts the send for that channel (result = false).
 *
 * Gate context is populated from message.metadata:
 *   - recipients:    string[] (optional; defaults to [])
 *   - sender_agent:  string  (optional; defaults to 'unknown')
 *
 * Returns per-channel delivery results.
 */
export async function routeMessage(
  message: OutboundMessage,
  channels?: string[],
): Promise<Record<string, boolean>> {
  const targets = channels && channels.length > 0
    ? channels.filter(c => adapters.has(c))
    : Array.from(adapters.keys());

  const results: Record<string, boolean> = {};

  await Promise.all(
    targets.map(async (channelName) => {
      const adapter = adapters.get(channelName);
      if (!adapter) {
        results[channelName] = false;
        return;
      }

      const verbosity = getVerbosity(channelName);
      const formattedText = adapter.formatMessage(message.text, verbosity);
      const formattedMessage: OutboundMessage = {
        ...message,
        text: formattedText,
      };

      // ── Outbound gate ────────────────────────────────────────
      if (_outboundGate) {
        const meta = message.metadata ?? {};
        const gateCtx: OutboundGateContext = {
          channel: channelName,
          recipient: Array.isArray(meta.recipients) ? (meta.recipients as string[]) : [],
          content: formattedText,
          rawContent: message.text,   // pre-format original — used for content_hash
          sender_agent: typeof meta.sender_agent === 'string' ? meta.sender_agent : 'unknown',
        };

        let gateResult = false;
        try {
          gateResult = await _outboundGate(gateCtx);
        } catch {
          // Gate threw — fail-closed
          gateResult = false;
        }

        if (!gateResult) {
          results[channelName] = false;
          return;
        }
      }
      // ── End gate ─────────────────────────────────────────────

      try {
        results[channelName] = await adapter.send(formattedMessage);
      } catch {
        results[channelName] = false;
      }
    }),
  );

  return results;
}

/**
 * Collect inbound messages from all channels.
 */
export async function collectInbound(): Promise<InboundMessage[]> {
  const all: InboundMessage[] = [];

  await Promise.all(
    Array.from(adapters.values()).map(async (adapter) => {
      try {
        const messages = await adapter.receive();
        all.push(...messages);
      } catch {
        // Skip channels with receive errors
      }
    }),
  );

  return all.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

// ── Testing ──────────────────────────────────────────────────

export function _resetForTesting(): void {
  adapters.clear();
  verbositySettings.clear();
  _outboundGate = null;
}
