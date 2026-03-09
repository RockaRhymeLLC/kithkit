import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../core/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 1000); // 3 per second for testing
  });

  it('allows requests under the limit', () => {
    assert.ok(limiter.check('ip1'));
    assert.ok(limiter.check('ip1'));
    assert.ok(limiter.check('ip1'));
  });

  it('blocks requests over the limit', () => {
    limiter.check('ip1');
    limiter.check('ip1');
    limiter.check('ip1');
    assert.ok(!limiter.check('ip1'));
  });

  it('tracks IPs independently', () => {
    limiter.check('ip1');
    limiter.check('ip1');
    limiter.check('ip1');
    assert.ok(!limiter.check('ip1'));
    assert.ok(limiter.check('ip2')); // different IP, should be allowed
  });

  it('reports remaining correctly', () => {
    assert.equal(limiter.remaining('ip1'), 3);
    limiter.check('ip1');
    assert.equal(limiter.remaining('ip1'), 2);
    limiter.check('ip1');
    assert.equal(limiter.remaining('ip1'), 1);
    limiter.check('ip1');
    assert.equal(limiter.remaining('ip1'), 0);
  });

  it('resets after window expires', async () => {
    limiter = new RateLimiter(2, 100); // 100ms window
    limiter.check('ip1');
    limiter.check('ip1');
    assert.ok(!limiter.check('ip1'));

    await new Promise(r => setTimeout(r, 150));
    assert.ok(limiter.check('ip1')); // window expired
  });

  it('stop clears all state', () => {
    limiter.check('ip1');
    limiter.startCleanup(100);
    limiter.stop();
    assert.equal(limiter.remaining('ip1'), 3); // cleared
  });
});
