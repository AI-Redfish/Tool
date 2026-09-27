import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from '../src/ratelimit.js';

test('RateLimiter：固定窗口内限流，窗口过后恢复', () => {
  let now = 1_000_000;
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.allow('k', now), true);
  assert.equal(rl.allow('k', now + 1), true);
  assert.equal(rl.allow('k', now + 2), true);
  assert.equal(rl.allow('k', now + 3), false);
  // 窗口滑动：最早的一条出窗后恢复
  assert.equal(rl.allow('k', now + 60_001), true);
  // 不同键互不影响
  assert.equal(rl.allow('k2', now), true);
});

test('RateLimiter：limit<=0 不限流', () => {
  const rl = new RateLimiter(0);
  for (let i = 0; i < 100; i++) assert.equal(rl.allow('k'), true);
});
