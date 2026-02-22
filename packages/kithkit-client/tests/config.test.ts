/**
 * Config Generation Tests
 *
 * Tests: t-084 (config on install), t-085 (config merge on upgrade)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateConfig, mergeConfig } from '../src/config.ts';
import type { ConfigField } from '../src/config.ts';

const WEATHER_V1_SCHEMA: ConfigField[] = [
  {
    key: 'api_key',
    type: 'credential',
    required: true,
    description: 'OpenWeather API key',
  },
  {
    key: 'default_location',
    type: 'string',
    required: false,
    default: '',
    description: 'Default location for weather checks',
  },
];

const WEATHER_V2_SCHEMA: ConfigField[] = [
  ...WEATHER_V1_SCHEMA,
  {
    key: 'units',
    type: 'enum',
    required: true,
    description: 'Temperature units',
    enum_values: ['metric', 'imperial'],
  },
];

describe('t-084: Config generated on install from manifest schema', () => {
  it('step 1: config.yaml generated with correct structure', () => {
    const result = generateConfig(WEATHER_V1_SCHEMA, 'weather-check');

    assert.ok(result.yaml.length > 0, 'Config YAML should be non-empty');
    assert.ok(result.yaml.includes('api_key'), 'Config should include api_key');
    assert.ok(result.yaml.includes('default_location'), 'Config should include default_location');
    assert.ok(result.fields['api_key'], 'Fields map should include api_key');
    assert.ok(result.fields['default_location'], 'Fields map should include default_location');
  });

  it('step 2: api_key has TODO comment, default_location has default', () => {
    const result = generateConfig(WEATHER_V1_SCHEMA, 'weather-check');

    // api_key is credential + required → TODO marker
    assert.ok(result.yaml.includes('TODO'), 'Credential field should have TODO marker');
    assert.ok(
      result.yaml.includes('api_key: ""') || result.yaml.includes("api_key: '' "),
      'api_key should be empty with TODO',
    );

    // default_location has default '' → should be pre-filled
    const locField = result.fields['default_location'];
    assert.equal(locField.value, '', 'default_location should have empty string default');
    assert.ok(!locField.needsSetup, 'default_location should not need setup');
  });

  it('step 3: credential-type field prompts for secure storage', () => {
    const result = generateConfig(WEATHER_V1_SCHEMA, 'weather-check');

    const apiKeyField = result.fields['api_key'];
    assert.ok(apiKeyField.isCredential, 'api_key should be flagged as credential');
    assert.ok(apiKeyField.needsSetup, 'api_key should need setup');
    assert.ok(apiKeyField.storageHint, 'api_key should have storage hint');
    assert.ok(
      apiKeyField.storageHint!.includes('Keychain'),
      'Storage hint should mention Keychain for macOS',
    );
    assert.ok(
      apiKeyField.storageHint!.includes('credential-weather-check-api_key'),
      'Storage hint should include credential name',
    );
    // Verify the YAML also includes the storage hint
    assert.ok(
      result.yaml.includes('credential-weather-check-api_key'),
      'YAML should include Keychain credential name',
    );
  });

  it('step 4: config is local-only (never uploaded)', () => {
    const result = generateConfig(WEATHER_V1_SCHEMA, 'weather-check');

    assert.ok(
      result.yaml.includes('LOCAL ONLY'),
      'Config should state LOCAL ONLY',
    );
    assert.ok(
      result.yaml.includes('never shared'),
      'Config should state never shared',
    );
  });
});

describe('t-085: Config merge on upgrade preserves existing values', () => {
  it('step 1: install v1 and populate with user values', () => {
    const result = generateConfig(WEATHER_V1_SCHEMA, 'weather-check');
    assert.ok(result.fields['api_key'], 'Should have api_key');
    assert.ok(result.fields['default_location'], 'Should have default_location');
  });

  it('step 2+3: upgrade merges, preserving existing values and marking new fields', () => {
    // Simulate existing config with user values
    const existingYaml = [
      'api_key: my-key',
      'default_location: NYC',
    ].join('\n');

    const result = mergeConfig(existingYaml, WEATHER_V2_SCHEMA, 'weather-check');

    // Existing values preserved
    assert.ok(result.preservedFields.includes('api_key'), 'api_key should be preserved');
    assert.ok(result.preservedFields.includes('default_location'), 'default_location should be preserved');
    assert.ok(result.yaml.includes('my-key'), 'api_key value should be preserved');
    assert.ok(result.yaml.includes('NYC'), 'default_location value should be preserved');

    // New field has TODO
    assert.ok(result.yaml.includes('units'), 'New units field should be present');
    assert.ok(result.yaml.includes('TODO'), 'New required field should have TODO');

    // Check allFields
    assert.equal(result.allFields['api_key'].value, 'my-key');
    assert.equal(result.allFields['default_location'].value, 'NYC');
    assert.equal(result.allFields['units'].needsSetup, true);
  });

  it('step 4: only new required fields flagged for setup', () => {
    const existingYaml = [
      'api_key: my-key',
      'default_location: NYC',
    ].join('\n');

    const result = mergeConfig(existingYaml, WEATHER_V2_SCHEMA, 'weather-check');

    // Only 'units' should be in newFields (the new required field)
    assert.equal(result.newFields.length, 1, 'Should have exactly 1 new field needing setup');
    assert.equal(result.newFields[0].key, 'units', 'New field should be units');
    assert.equal(result.newFields[0].needsSetup, true, 'units should need setup');

    // api_key and default_location should NOT be in newFields
    const newFieldKeys = result.newFields.map(f => f.key);
    assert.ok(!newFieldKeys.includes('api_key'), 'api_key should not be in new fields');
    assert.ok(!newFieldKeys.includes('default_location'), 'default_location should not be in new fields');
  });

  it('preserves values when upgrading with no new required fields', () => {
    const existingYaml = [
      'api_key: my-key',
      'default_location: NYC',
    ].join('\n');

    // "Upgrade" to same schema — no new fields
    const result = mergeConfig(existingYaml, WEATHER_V1_SCHEMA, 'weather-check');

    assert.equal(result.newFields.length, 0, 'No new fields when schema unchanged');
    assert.equal(result.preservedFields.length, 2, 'Both fields preserved');
    assert.ok(result.yaml.includes('my-key'));
    assert.ok(result.yaml.includes('NYC'));
  });

  it('handles enum field with options listed in comments', () => {
    const existingYaml = 'api_key: my-key\ndefault_location: NYC';
    const result = mergeConfig(existingYaml, WEATHER_V2_SCHEMA, 'weather-check');

    assert.ok(
      result.yaml.includes('metric') && result.yaml.includes('imperial'),
      'Enum options should be listed in comments',
    );
  });
});
