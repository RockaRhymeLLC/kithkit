import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkNaming, levenshtein } from '../src/checks/naming.ts';

// --- t-071: Naming check validates skill names ---

describe('t-071: Naming check validates skill names', () => {
  it('step 1: valid name passes', () => {
    const result = checkNaming('weather-check');
    assert.equal(result.pass, true);
  });

  it('step 2: uppercase name fails', () => {
    const result = checkNaming('WeatherCheck');
    assert.equal(result.pass, false);
    const finding = result.findings.find(f => f.check === 'naming/case' || f.check === 'naming/pattern');
    assert.ok(finding, 'Expected naming error for uppercase');
  });

  it('step 3: too short name fails', () => {
    const result = checkNaming('a');
    assert.equal(result.pass, false);
    const finding = result.findings.find(f => f.check === 'naming/length');
    assert.ok(finding, 'Expected length error');
  });

  it('step 4: reserved name fails', () => {
    const result = checkNaming('kithkit');
    assert.equal(result.pass, false);
    const finding = result.findings.find(f => f.check === 'naming/reserved');
    assert.ok(finding, 'Expected reserved name error');
  });

  it('step 5: similar name warns (typosquat)', () => {
    const result = checkNaming('wether-check', ['weather-check']);
    const finding = result.findings.find(f => f.check === 'naming/typosquat');
    assert.ok(finding, 'Expected typosquat warning');
    assert.equal(finding!.severity, 'warning');
    // Verify Levenshtein distance
    const dist = levenshtein('wether-check', 'weather-check');
    assert.ok(dist <= 2, `Expected distance <= 2, got ${dist}`);
  });
});
