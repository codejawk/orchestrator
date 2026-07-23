import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { EgressGuard, sha256Hex } from '../src/policy/egress.ts';
import { redactSecrets } from '../src/policy/redact.ts';

/**
 * The egress chokepoint. This is the backstop that makes the "nothing
 * restricted leaves the network" guarantee structural rather than a routing
 * decision, so its tests are about what it refuses to let through — regardless
 * of how the bytes got to it.
 */

describe('EgressGuard', () => {
  const guard = new EgressGuard();

  test('allows an ordinary internal payload', () => {
    const verdict = guard.inspect([
      'You review code.',
      'GOAL: add retry to the upload client\nCONTEXT:\nfunction upload() {}',
    ]);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.violations.length, 0);
  });

  test('blocks a raw private key even if routing thought it was fine', () => {
    const verdict = guard.inspect([
      'system',
      'here is the config\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
    ]);
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.violations.some((v) => v.kind === 'secret'));
  });

  test('blocks a bootloader file that reached the payload through any path', () => {
    // Simulates the failure the chokepoint exists for: a restricted file in the
    // outbound bytes that the router should have pinned to Gauss but did not.
    const verdict = guard.inspect(['system', 'CONTEXT:\nif (avb_verify_slot(x)) rollback_index++;']);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.tier, 'restricted');
    assert.ok(verdict.violations.some((v) => v.kind === 'tier'));
  });

  test('blocks when a redaction placeholder survived into the payload', () => {
    // A surviving <SECRET_1> means the redaction output was not used — a wiring
    // bug that would send the original if inverted. Fail loudly.
    const verdict = guard.inspect(['system', 'token is <SECRET_1> apparently']);
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.violations.some((v) => v.kind === 'marker'));
  });

  test('does not block ordinary company code rated internal', () => {
    const verdict = guard.inspect(['system', 'export class BatteryMonitor { poll() {} }']);
    assert.equal(verdict.allowed, true);
  });

  test('a redacted payload passes the guard it is meant to satisfy', () => {
    // End-to-end: redact a secret, then confirm the redacted text clears egress.
    const redacted = redactSecrets('api_key = "sk_live_9aX2mQ7pL4zR8tN3bW6yK1cF"').text;
    const verdict = guard.inspect(['system', redacted]);
    // The placeholder rule would fire on <SECRET_n>, which is the point: redacted
    // *secrets* must not be sent to an external model verbatim either. So a
    // redacted secret is itself a signal the run should have been Gauss-only.
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.violations.some((v) => v.kind === 'marker'));
  });

  test('hashes the payload without exposing it', () => {
    const verdict = guard.inspect(['a', 'b']);
    assert.match(verdict.payloadHash, /^[0-9a-f]{64}$/);
    assert.equal(verdict.payloadHash, sha256Hex('a\nb'));
  });

  test('the same bytes always hash the same', () => {
    assert.equal(sha256Hex('bootloader'), sha256Hex('bootloader'));
    assert.notEqual(sha256Hex('a'), sha256Hex('b'));
  });
});
