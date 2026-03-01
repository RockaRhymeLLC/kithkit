/**
 * BMO Config — extends the base KithkitConfig with BMO-specific sections.
 *
 * These sections are loaded from kithkit.config.yaml alongside the base config.
 * The deep-merge in config.ts handles unknown keys transparently, so these
 * fields are present in the raw config object — this type makes them type-safe.
 */
/**
 * Cast a KithkitConfig to BmoConfig.
 * Safe because the deep-merge preserves all keys from the YAML.
 */
export function asBmoConfig(config) {
    return config;
}
//# sourceMappingURL=config.js.map