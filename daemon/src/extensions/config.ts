/**
 * Agent Config — extends the base KithkitConfig with agent-specific sections.
 *
 * These sections are loaded from kithkit.config.yaml alongside the base config.
 * The deep-merge in config.ts handles unknown keys transparently, so these
 * fields are present in the raw config object — this type makes them type-safe.
 */

import type { KithkitConfig } from '../core/config.js';

// ── Channel Config ──────────────────────────────────────────

export interface TelegramChannelConfig {
  enabled: boolean;
  webhook_path?: string;
}

export interface EmailProviderConfig {
  type: 'graph' | 'jmap' | 'himalaya' | 'outlook';
  account?: string;
}

export interface EmailTriageConfig {
  enabled: boolean;
  vip?: string[];
  junk?: string[];
  newsletters?: string[];
  receipts?: string[];
  auto_read?: string[];
}

export interface EmailChannelConfig {
  enabled: boolean;
  providers?: EmailProviderConfig[];
  triage?: EmailTriageConfig;
}

export interface VoiceConfig {
  enabled: boolean;
  stt?: {
    engine: string;
    model?: string;
    language?: string;
  };
  tts?: {
    engine: string;
    voice?: string;
    speed?: number;
  };
  wake_word?: {
    engine: string;
    phrase?: string;
  };
  client?: Record<string, unknown>;
  initiation?: Record<string, unknown>;
}

export interface ChannelsConfig {
  telegram?: TelegramChannelConfig;
  email?: EmailChannelConfig;
  voice?: VoiceConfig;
}

// ── Network Config ──────────────────────────────────────────

export interface NetworkCommunity {
  name: string;
  primary: string;
  failover?: string;
}

export interface NetworkConfig {
  enabled: boolean;
  communities?: NetworkCommunity[];
  owner_email?: string;
  endpoint?: string;
  auto_approve_contacts?: boolean;
  heartbeat_interval?: number;
}

// ── Agent Comms Config ──────────────────────────────────────

export interface PeerConfig {
  name: string;
  host: string;
  port: number;
  ip?: string;
}

export interface AgentCommsConfig {
  enabled: boolean;
  secret?: string;
  peers?: PeerConfig[];
}

// ── A2A Security Config ─────────────────────────────────────

/**
 * Per-endpoint signing enforcement posture.
 *   enforce    — reject unsigned requests when an HMAC key is configured
 *   permissive — warn but accept unsigned (transition / trusted-LAN default)
 *
 * The posture only applies when the HMAC key (credential-agent-comms-secret)
 * is present in the Keychain. When no key is configured, both endpoints
 * preserve current permissive behaviour regardless of this setting.
 */
export type A2ASigningPosture = 'enforce' | 'permissive';

export interface A2ASecurityConfig {
  /** /agent/p2p signing posture. Default: enforce (internet-reachable via relay). */
  p2p?: A2ASigningPosture;
  /** /agent/message signing posture. Default: permissive (trusted home LAN). */
  message?: A2ASigningPosture;
}

export interface A2AConfig {
  security?: A2ASecurityConfig;
}

// ── Integrations Config ─────────────────────────────────────

export interface BrowserbaseConfig {
  enabled: boolean;
  sidecar_port?: number;
  default_timeout?: number;
  idle_warning?: number;
  handoff_timeout?: number;
  handoff_session_timeout?: number;
  block_ads?: boolean;
  solve_captchas?: boolean;
  record_sessions?: boolean;
}

export interface IntegrationsConfig {
  browserbase?: BrowserbaseConfig;
}

// ── Agent Config ────────────────────────────────────────────

/**
 * Full agent config — KithkitConfig + agent-specific sections.
 *
 * Usage:
 *   import { loadConfig } from '../core/config.js';
 *   const config = loadConfig(projectDir) as AgentConfig;
 */
export interface AgentConfig extends KithkitConfig {
  channels?: ChannelsConfig;
  network?: NetworkConfig;
  'agent-comms'?: AgentCommsConfig;
  integrations?: IntegrationsConfig;
  a2a?: A2AConfig;
}

/**
 * Cast a KithkitConfig to AgentConfig.
 * Safe because the deep-merge preserves all keys from the YAML.
 */
export function asAgentConfig(config: KithkitConfig): AgentConfig {
  return config as AgentConfig;
}
