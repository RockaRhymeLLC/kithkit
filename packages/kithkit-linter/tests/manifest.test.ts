import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseAndValidateManifest, validateManifest } from '../src/checks/manifest.ts';
import { isKnownCapability, WELL_KNOWN_CAPABILITIES, getCapabilityDescription } from '../src/capabilities.ts';

// --- t-060: Valid manifest passes schema validation ---

describe('t-060: Valid manifest passes schema validation', () => {
  const validYaml = `
name: weather-check
version: 1.0.0
description: Check weather forecasts for any location
author:
  name: Jane Doe
  github: janedoe
capabilities:
  required:
    - web_fetch
    - notification
  optional:
    - memory_write
config:
  - key: api_key
    type: credential
    required: true
    description: OpenWeather API key
  - key: units
    type: enum
    required: false
    default: metric
    description: Temperature units
    enum_values:
      - metric
      - imperial
tags:
  - weather
  - utility
category: utilities
frameworks:
  tested:
    - claude-code
`;

  it('step 1: valid YAML parses successfully', () => {
    const result = parseAndValidateManifest(validYaml);
    // Should have no errors (may have info)
    const errors = result.findings.filter(f => f.severity === 'error');
    assert.equal(errors.length, 0, `Expected no errors, got: ${errors.map(e => e.message).join(', ')}`);
  });

  it('step 2: validation passes with no errors', () => {
    const result = parseAndValidateManifest(validYaml);
    assert.equal(result.pass, true);
  });

  it('step 3: trust_level is not set by author', () => {
    const yamlWithTrustLevel = validYaml + '\ntrust_level: verified\n';
    const result = parseAndValidateManifest(yamlWithTrustLevel);
    // Should pass (trust_level is ignored/info, not error)
    assert.equal(result.pass, true);
    // Should have an info finding about trust_level being catalog-set
    const trustInfo = result.findings.find(f =>
      f.check === 'manifest/trust_level' && f.severity === 'info'
    );
    assert.ok(trustInfo, 'Expected info finding about trust_level being catalog-set');
  });
});

// --- t-061: Invalid manifest rejected with specific errors ---

describe('t-061: Invalid manifest rejected with specific errors', () => {
  it('step 1: missing name field', () => {
    const yaml = `
version: 1.0.0
description: A skill
author:
  name: Test
  github: test
capabilities:
  required:
    - bash
`;
    const result = parseAndValidateManifest(yaml);
    assert.equal(result.pass, false);
    const nameError = result.findings.find(f =>
      f.severity === 'error' && f.check === 'manifest/name' && f.message.includes("'name' is required")
    );
    assert.ok(nameError, "Expected error: 'name' is required");
  });

  it('step 2: invalid semver', () => {
    const yaml = `
name: test-skill
version: 1.2.x
description: A skill
author:
  name: Test
  github: test
capabilities:
  required:
    - bash
`;
    const result = parseAndValidateManifest(yaml);
    assert.equal(result.pass, false);
    const versionError = result.findings.find(f =>
      f.severity === 'error' && f.check === 'manifest/version' && f.message.includes('invalid semver')
    );
    assert.ok(versionError, 'Expected error: invalid semver');
  });

  it('step 3: uppercase name rejected', () => {
    const yaml = `
name: UPPER-CASE
version: 1.0.0
description: A skill
author:
  name: Test
  github: test
capabilities:
  required:
    - bash
`;
    const result = parseAndValidateManifest(yaml);
    assert.equal(result.pass, false);
    const nameError = result.findings.find(f =>
      f.severity === 'error' && f.check === 'manifest/name' && f.message.includes('lowercase')
    );
    assert.ok(nameError, 'Expected error: name must be lowercase');
  });

  it('step 4: invalid config type rejected', () => {
    const yaml = `
name: test-skill
version: 1.0.0
description: A skill
author:
  name: Test
  github: test
capabilities:
  required:
    - bash
config:
  - key: api_key
    type: invalid-type
    required: true
    description: An API key
`;
    const result = parseAndValidateManifest(yaml);
    assert.equal(result.pass, false);
    const typeError = result.findings.find(f =>
      f.severity === 'error' && f.check === 'manifest/config' && f.message.includes('credential|string|number|boolean|enum')
    );
    assert.ok(typeError, 'Expected error: config type must be one of credential|string|number|boolean|enum');
  });
});

// --- t-062: Capability namespace validates known and unknown capabilities ---

describe('t-062: Capability namespace validates known and unknown capabilities', () => {
  it('step 1: known capabilities accepted without warnings', () => {
    const yaml = `
name: test-skill
version: 1.0.0
description: A skill
author:
  name: Test
  github: test
capabilities:
  required:
    - file_read
    - bash
    - web_fetch
`;
    const result = parseAndValidateManifest(yaml);
    assert.equal(result.pass, true);
    const capWarnings = result.findings.filter(f =>
      f.check === 'manifest/capabilities' && f.severity === 'warning' && f.message.includes('unknown')
    );
    assert.equal(capWarnings.length, 0, 'Expected no unknown capability warnings');
  });

  it('step 2: unknown capability warns but does not error', () => {
    const yaml = `
name: test-skill
version: 1.0.0
description: A skill
author:
  name: Test
  github: test
capabilities:
  required:
    - custom_capability
`;
    const result = parseAndValidateManifest(yaml);
    assert.equal(result.pass, true, 'Unknown capability should not fail validation');
    const customWarning = result.findings.find(f =>
      f.severity === 'warning' && f.message.includes("unknown capability 'custom_capability'")
    );
    assert.ok(customWarning, 'Expected warning for unknown capability');
  });

  it('step 3: empty required capabilities warns', () => {
    const yaml = `
name: test-skill
version: 1.0.0
description: A skill
author:
  name: Test
  github: test
capabilities:
  required: []
`;
    const result = parseAndValidateManifest(yaml);
    const emptyWarning = result.findings.find(f =>
      f.severity === 'warning' && f.message.includes('no required capabilities')
    );
    assert.ok(emptyWarning, 'Expected warning for empty required capabilities');
  });

  it('step 4: all well-known capabilities have descriptions', () => {
    for (const cap of WELL_KNOWN_CAPABILITIES) {
      assert.ok(cap.description.length > 0, `Capability '${cap.name}' has no description`);
      assert.equal(typeof cap.description, 'string');
    }
    // Also verify the helper functions work
    assert.equal(isKnownCapability('file_read'), true);
    assert.equal(isKnownCapability('made_up_thing'), false);
    assert.ok(getCapabilityDescription('bash'));
    assert.equal(getCapabilityDescription('nonexistent'), undefined);
  });
});
