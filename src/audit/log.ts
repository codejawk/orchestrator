import { createHash, randomBytes } from 'node:crypto';
import type { AdapterId, Tier } from '../types/ir.ts';

/**
 * Tamper-evident audit log.
 *
 * Enterprise compliance needs a record of what left the network, when, at whose
 * request, and under what classification. A plain append-only list does not
 * meet that bar: anyone with file access can edit a row and no one can tell.
 *
 * Two properties fix that:
 *
 *   1. **Hash chaining.** Each record carries the hash of the record before it,
 *      and its own hash is computed over that chain link. Editing or deleting
 *      any record breaks every hash after it, so `verify()` can point at the
 *      exact row where the log was altered. You cannot quietly remove the entry
 *      that shows bootloader source was sent externally.
 *
 *   2. **Salted content hashes.** Prompts and responses are stored as hashes,
 *      not plaintext — the log should prove what happened without becoming a
 *      second copy of the sensitive data. A per-workspace random salt is mixed
 *      in first, because an unsalted SHA of a short prompt ("fix the bug") is
 *      trivially reversed with a dictionary.
 *
 * This is tamper-*evident*, not tamper-*proof*: someone who can rewrite the
 * whole file and recompute the chain from a chosen point can forge a consistent
 * history. Defeating that needs an external anchor — periodically publishing the
 * head hash to an append-only store the developer cannot rewrite. The head hash
 * is exposed here precisely so that anchoring can be added without reworking the
 * log.
 */

export type AuditEvent =
  | 'scan'
  | 'approval'
  | 'plan'
  | 'dispatch'
  | 'egress-block'
  | 'result'
  | 'report';

/** The stored, hashed record. Never contains prompt or response plaintext. */
export interface AuditRecord {
  seq: number;
  at: string;
  event: AuditEvent;
  /** Hash of the previous record, or the genesis constant for seq 0. */
  prevHash: string;
  /** This record's hash: sha256(prevHash + canonical(payload)). */
  hash: string;

  planId?: string;
  subtaskId?: string;
  adapter?: AdapterId;
  model?: string;
  tier?: Tier;
  /** Paths referenced — file names, never file contents. */
  files?: string[];
  decision?: string;
  usd?: number;
  tokens?: number;
  /** Salted hash of the outbound prompt, when the event sent one. */
  promptHash?: string;
  /** Salted hash of the response, when the event received one. */
  responseHash?: string;
}

/** The fields a caller supplies; the chain fields are filled in by append(). */
export type AuditInput = Omit<AuditRecord, 'seq' | 'at' | 'prevHash' | 'hash'>;

const GENESIS = 'GENESIS';

/** Persistence, injected so the log is testable without vscode. */
export interface AuditStore {
  load(): AuditRecord[];
  save(records: AuditRecord[]): Promise<void>;
}

export class AuditLog {
  private readonly store: AuditStore;
  private readonly salt: string;
  private records: AuditRecord[];

  constructor(store: AuditStore, salt: string) {
    this.store = store;
    this.salt = salt;
    // Copy on load so the log owns its array and a store that hands back a live
    // reference cannot be mutated out from under us.
    this.records = [...store.load()];
  }

  /** Salted hash of sensitive text, for the promptHash / responseHash fields. */
  hashContent(text: string): string {
    return createHash('sha256').update(this.salt).update('\x00').update(text, 'utf8').digest('hex');
  }

  async append(input: AuditInput): Promise<AuditRecord> {
    const prev = this.records[this.records.length - 1];
    const prevHash = prev ? prev.hash : GENESIS;
    const seq = this.records.length;
    const at = new Date().toISOString();

    const record: AuditRecord = {
      ...input,
      seq,
      at,
      prevHash,
      hash: '',
    };
    record.hash = linkHash(prevHash, record);

    this.records.push(record);
    // Persist a copy, not the live array. A store that mutates what it is given
    // (or aliases it back through load()) would otherwise corrupt the chain.
    await this.store.save([...this.records]);
    return record;
  }

  /**
   * Walks the chain. Returns ok, or the sequence number of the first record
   * whose hash does not match — which is where tampering began.
   */
  verify(): { ok: true } | { ok: false; brokenAt: number; reason: string } {
    let prevHash = GENESIS;
    for (const record of this.records) {
      if (record.prevHash !== prevHash) {
        return { ok: false, brokenAt: record.seq, reason: 'prevHash does not match the chain' };
      }
      if (linkHash(prevHash, record) !== record.hash) {
        return { ok: false, brokenAt: record.seq, reason: 'record hash does not match its contents' };
      }
      prevHash = record.hash;
    }
    return { ok: true };
  }

  /** Current head hash, for external anchoring. */
  head(): string {
    return this.records[this.records.length - 1]?.hash ?? GENESIS;
  }

  all(): readonly AuditRecord[] {
    return this.records;
  }

  forPlan(planId: string): AuditRecord[] {
    return this.records.filter((record) => record.planId === planId);
  }
}

/**
 * The chain link. Hashes prevHash together with a canonical serialization of
 * the record's own fields — canonical so that key order can never change the
 * hash and let a re-serialization pass verification with different bytes.
 */
function linkHash(prevHash: string, record: AuditRecord): string {
  const { hash: _ignored, ...rest } = record;
  return createHash('sha256').update(prevHash).update('\x00').update(canonical(rest)).digest('hex');
}

/** Deterministic JSON: keys sorted at every level. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Generates a salt for a workspace that does not have one yet. */
export function newSalt(): string {
  return randomBytes(32).toString('hex');
}
