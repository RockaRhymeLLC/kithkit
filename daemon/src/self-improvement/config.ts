/**
 * Self-improvement subsystem configuration.
 * Reads from the daemon's config system and applies typed defaults.
 */

import { loadConfig } from '../core/config.js';

// ── Types ─────────────────────────────────────────────────────

export interface SelfImprovementConfig {
  enabled: boolean;
  retro: {
    enabled: boolean;
    triggers: { on_error: boolean; on_correction: boolean; on_retry: boolean };
    max_learnings_per_retro: number;
  };
  transcript_review: {
    enabled: boolean;
    interval_actions: number;
    interval_minutes: number;
    max_learnings_per_review: number;
  };
  correction_trigger: {
    enabled: boolean;
  };
  pre_task_injection: {
    enabled: boolean;
    max_memories_injected: number;
    min_relevance_score: number;
  };
  memory_sync: {
    enabled: boolean;
    peers: string[];
  };
  lifecycle: {
    consolidation_threshold: number;
    category_cap: number;
    decay: Record<string, string>;
  };
}

// ── Defaults ─────────────────────────────────────────────────

const DEFAULTS: SelfImprovementConfig = {
  enabled: false,
  retro: {
    enabled: false,
    triggers: { on_error: true, on_correction: true, on_retry: true },
    max_learnings_per_retro: 5,
  },
  transcript_review: {
    enabled: false,
    interval_actions: 25,
    interval_minutes: 30,
    max_learnings_per_review: 3,
  },
  correction_trigger: {
    enabled: false,
  },
  pre_task_injection: {
    enabled: false,
    max_memories_injected: 10,
    min_relevance_score: 0.4,
  },
  memory_sync: {
    enabled: false,
    peers: [],
  },
  lifecycle: {
    consolidation_threshold: 0.85,
    category_cap: 50,
    decay: {
      default: '30d',
      short: '7d',
      evergreen: 'never',
    },
  },
};

// ── Accessor ─────────────────────────────────────────────────

type RawSelfImprovement = Partial<{
  enabled: boolean;
  retro: Partial<{
    enabled: boolean;
    triggers: Partial<{ on_error: boolean; on_correction: boolean; on_retry: boolean }>;
    max_learnings_per_retro: number;
  }>;
  transcript_review: Partial<{
    enabled: boolean;
    interval_actions: number;
    interval_minutes: number;
    max_learnings_per_review: number;
  }>;
  correction_trigger: Partial<{ enabled: boolean }>;
  pre_task_injection: Partial<{
    enabled: boolean;
    max_memories_injected: number;
    min_relevance_score: number;
  }>;
  memory_sync: Partial<{ enabled: boolean; peers: string[] }>;
  lifecycle: Partial<{
    consolidation_threshold: number;
    category_cap: number;
    decay: Record<string, string>;
  }>;
}>;

/**
 * Returns the self-improvement configuration, merging user config with defaults.
 * All fields are guaranteed to be present and typed.
 */
export function getSelfImprovementConfig(): SelfImprovementConfig {
  const config = loadConfig() as unknown as Record<string, unknown>;
  const raw = (config['self_improvement'] ?? {}) as RawSelfImprovement;

  return {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    retro: {
      enabled: raw.retro?.enabled ?? DEFAULTS.retro.enabled,
      triggers: {
        on_error: raw.retro?.triggers?.on_error ?? DEFAULTS.retro.triggers.on_error,
        on_correction: raw.retro?.triggers?.on_correction ?? DEFAULTS.retro.triggers.on_correction,
        on_retry: raw.retro?.triggers?.on_retry ?? DEFAULTS.retro.triggers.on_retry,
      },
      max_learnings_per_retro:
        raw.retro?.max_learnings_per_retro ?? DEFAULTS.retro.max_learnings_per_retro,
    },
    transcript_review: {
      enabled: raw.transcript_review?.enabled ?? DEFAULTS.transcript_review.enabled,
      interval_actions:
        raw.transcript_review?.interval_actions ?? DEFAULTS.transcript_review.interval_actions,
      interval_minutes:
        raw.transcript_review?.interval_minutes ?? DEFAULTS.transcript_review.interval_minutes,
      max_learnings_per_review:
        raw.transcript_review?.max_learnings_per_review ??
        DEFAULTS.transcript_review.max_learnings_per_review,
    },
    correction_trigger: {
      enabled: raw.correction_trigger?.enabled ?? DEFAULTS.correction_trigger.enabled,
    },
    pre_task_injection: {
      enabled: raw.pre_task_injection?.enabled ?? DEFAULTS.pre_task_injection.enabled,
      max_memories_injected:
        raw.pre_task_injection?.max_memories_injected ??
        DEFAULTS.pre_task_injection.max_memories_injected,
      min_relevance_score:
        raw.pre_task_injection?.min_relevance_score ??
        DEFAULTS.pre_task_injection.min_relevance_score,
    },
    memory_sync: {
      enabled: raw.memory_sync?.enabled ?? DEFAULTS.memory_sync.enabled,
      peers: raw.memory_sync?.peers ?? DEFAULTS.memory_sync.peers,
    },
    lifecycle: {
      consolidation_threshold:
        raw.lifecycle?.consolidation_threshold ?? DEFAULTS.lifecycle.consolidation_threshold,
      category_cap: raw.lifecycle?.category_cap ?? DEFAULTS.lifecycle.category_cap,
      decay: raw.lifecycle?.decay ?? DEFAULTS.lifecycle.decay,
    },
  };
}
