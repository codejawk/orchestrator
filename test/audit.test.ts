import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { AuditLog, canonical, newSalt, type AuditRecord, type AuditStore } from '../src/audit/log.ts';

/**
 * The audit log's whole value is that tampering is detectable, so the tests are
 * almost entirely about breaking the chain and confirming verify() notices.
 */

function memoryStore(seed: AuditRecord[] = []): { store: AuditStore; records: AuditRecord[] } {
  const records = [...seed];
  return {
    records,
    store: {
      load: () => records,
      save: async (next) => {
        records.length = 0;
        records.push(...next);
      },
    },
  };
}

describe('canonical', () => {
  test('is independent of key order', () => {
    assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  });

  test('omits undefined fields so optional keys do not change the hash', () => {
    assert.equal(canonical({ a: 1, b: undefined }), canonical({ a: 1 }));
  });

  test('handles nested structures deterministically', () => {
    assert.equal(canonical({ x: [{ b: 1, a: 2 }] }), '{"x":[{"a":2,"b":1}]}');
  });
});

describe('AuditLog', () => {
  test('chains records and verifies an intact log', async () => {
    const { store } = memoryStore();
    const log = new AuditLog(store, newSalt());

    await log.append({ event: 'scan', decision: 'a' });
    await log.append({ event: 'dispatch', adapter: 'claude', decision: 'b' });
    await log.append({ event: 'result', adapter: 'claude', decision: 'c' });

    assert.equal(log.verify().ok, true);
    assert.equal(log.all().length, 3);
    assert.equal(log.all()[0]?.prevHash, 'GENESIS');
    assert.equal(log.all()[1]?.prevHash, log.all()[0]?.hash);
  });

  test('detects an edited record', async () => {
    const { store, records } = memoryStore();
    const log = new AuditLog(store, newSalt());
    await log.append({ event: 'scan', decision: 'original' });
    await log.append({ event: 'dispatch', decision: 'next' });

    // Someone edits the persisted decision without recomputing hashes.
    records[0]!.decision = 'tampered';

    const reloaded = new AuditLog(store, newSalt());
    const result = reloaded.verify();
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.brokenAt, 0);
  });

  test('detects a deleted record by the break in prevHash', async () => {
    const { store, records } = memoryStore();
    const log = new AuditLog(store, newSalt());
    await log.append({ event: 'scan', decision: 'a' });
    await log.append({ event: 'dispatch', decision: 'b' });
    await log.append({ event: 'result', decision: 'c' });

    // Delete the middle record and renumber nothing — a naive tamper.
    records.splice(1, 1);

    const reloaded = new AuditLog(store, newSalt());
    assert.equal(reloaded.verify().ok, false);
  });

  test('detects a record inserted at the end without a valid link', async () => {
    const { store, records } = memoryStore();
    const log = new AuditLog(store, newSalt());
    await log.append({ event: 'scan', decision: 'a' });

    records.push({
      seq: 1,
      at: new Date().toISOString(),
      event: 'dispatch',
      prevHash: 'made-up-hash',
      hash: 'also-made-up',
      decision: 'forged',
    });

    const reloaded = new AuditLog(store, newSalt());
    const result = reloaded.verify();
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.brokenAt, 1);
  });

  test('salts content hashes so identical prompts are not trivially matched', () => {
    const a = new AuditLog(memoryStore().store, 'salt-one');
    const b = new AuditLog(memoryStore().store, 'salt-two');

    // Same prompt, different workspace salt → different stored hash. Prevents
    // cross-workspace correlation and rainbow-tabling of short prompts.
    assert.notEqual(a.hashContent('fix the bug'), b.hashContent('fix the bug'));
    // Deterministic within a workspace, so the record is reproducible.
    assert.equal(a.hashContent('fix the bug'), a.hashContent('fix the bug'));
  });

  test('head advances and exposes the value for external anchoring', async () => {
    const log = new AuditLog(memoryStore().store, newSalt());
    assert.equal(log.head(), 'GENESIS');
    const record = await log.append({ event: 'scan' });
    assert.equal(log.head(), record.hash);
  });

  test('filters by plan for per-run reporting', async () => {
    const log = new AuditLog(memoryStore().store, newSalt());
    await log.append({ event: 'dispatch', planId: 'p1' });
    await log.append({ event: 'dispatch', planId: 'p2' });
    await log.append({ event: 'result', planId: 'p1' });

    assert.equal(log.forPlan('p1').length, 2);
  });
});
