import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { CircuitBreaker, SpendGuard } from '../src/exec/breaker.ts';

describe('CircuitBreaker', () => {
  test('trips after the threshold of infrastructure failures', () => {
    const breaker = new CircuitBreaker(2);
    assert.equal(breaker.isTripped('claude'), false);
    assert.equal(breaker.recordFailure('claude'), false);
    assert.equal(breaker.recordFailure('claude'), true);
    assert.equal(breaker.isTripped('claude'), true);
  });

  test('is per adapter', () => {
    const breaker = new CircuitBreaker(1);
    breaker.recordFailure('claude');
    assert.equal(breaker.isTripped('claude'), true);
    assert.equal(breaker.isTripped('codex'), false);
  });

  test('a success resets the count, so a flaky-then-healthy adapter recovers', () => {
    const breaker = new CircuitBreaker(2);
    breaker.recordFailure('gemini');
    breaker.recordSuccess('gemini');
    breaker.recordFailure('gemini');
    assert.equal(breaker.isTripped('gemini'), false);
  });
});

describe('SpendGuard', () => {
  test('is disabled when the cap is zero', () => {
    const guard = new SpendGuard(0);
    guard.add(100);
    assert.equal(guard.enabled, false);
    assert.equal(guard.exceeded, false);
  });

  test('counts planning cost seeded up front', () => {
    const guard = new SpendGuard(1.0, 0.9);
    assert.equal(guard.exceeded, false);
    guard.add(0.2);
    assert.equal(guard.exceeded, true);
  });

  test('trips exactly at the cap', () => {
    const guard = new SpendGuard(0.5);
    guard.add(0.49);
    assert.equal(guard.exceeded, false);
    guard.add(0.01);
    assert.equal(guard.exceeded, true);
  });

  test('the reason names the cap and the spend', () => {
    const guard = new SpendGuard(2, 2);
    assert.match(guard.reason(), /\$2\.00/);
    assert.match(guard.reason(), /maxRunUsd/);
  });
});
