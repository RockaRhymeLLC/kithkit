/**
 * Channel Router — manages multiple channel adapters and routes messages.
 *
 * Supports multi-channel delivery (send to multiple channels at once).
 * Each channel has its own verbosity setting. Inbound messages from
 * any channel can be collected and injected into the comms agent.
 */

import type {
  ChannelAdapter,
  OutboundMessage,
  InboundMessage,
  Verbosity,
} from './adapter.js';

// ── State ────────────────────────────────────────────────────

const adapters = new Map<string, ChannelAdapter>();
const verbositySettings = new Map<string, Verbosity>();

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
}
