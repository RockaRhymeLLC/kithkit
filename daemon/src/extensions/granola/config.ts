/**
 * Granola Extension Config — reads integrations.granola block from kithkit.config.yaml.
 */

import type { KithkitConfig } from '../../core/config.js';

export interface GranolaConfig {
  enabled: boolean;
  poll_interval_minutes: number;
  include_transcripts: boolean;
  extraction_enabled: boolean;
  extraction_model: string;
  api_base_url: string;
}

const DEFAULTS: GranolaConfig = {
  enabled: false,
  poll_interval_minutes: 15,
  include_transcripts: false,
  extraction_enabled: true,
  extraction_model: 'claude-sonnet-4-6',
  api_base_url: 'https://public-api.granola.ai',
};

export function getGranolaConfig(config: KithkitConfig): GranolaConfig {
  const raw = config as unknown as Record<string, unknown>;
  const integrations = raw['integrations'] as Record<string, unknown> | undefined;
  const granola = integrations?.['granola'] as Partial<GranolaConfig> | undefined;

  if (!granola) return { ...DEFAULTS };

  return {
    enabled: granola.enabled ?? DEFAULTS.enabled,
    poll_interval_minutes: granola.poll_interval_minutes ?? DEFAULTS.poll_interval_minutes,
    include_transcripts: granola.include_transcripts ?? DEFAULTS.include_transcripts,
    extraction_enabled: granola.extraction_enabled ?? DEFAULTS.extraction_enabled,
    extraction_model: granola.extraction_model ?? DEFAULTS.extraction_model,
    api_base_url: (granola.api_base_url ?? DEFAULTS.api_base_url).replace(/\/$/, ''),
  };
}
