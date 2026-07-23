import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { OrchestratorSession } from '../src/session.ts';

/**
 * Multi-turn conversation state. The behaviour a user sees ("I can keep asking
 * related things in one chat") rests on a session surviving across turns, and
 * the security of that rests on the taint and the redaction map surviving with
 * it. These tests pin both.
 *
 * The pipeline methods that drive a session need vscode, so these exercise the
 * session's own cross-turn contract directly rather than the full pipeline.
 */

describe('OrchestratorSession as a conversation', () => {
  test('startTurn resets per-turn state but keeps the workspace scan', () => {
    const session = new OrchestratorSession('c1');
    session.files = [{ path: 'a.ts' } as never];
    session.candidates = [{ path: 'a.ts' } as never];
    session.plan = { id: 'p1' } as never;
    session.answers = [{ id: 'q', question: 'q', answer: 'a' }];

    session.startTurn();

    assert.equal(session.files.length, 1, 'the expensive scan is reused across turns');
    assert.equal(session.candidates.length, 1);
    assert.equal(session.plan, undefined, 'the prior plan does not leak into the new turn');
    assert.deepEqual(session.answers, []);
  });

  test('needsSweep flips once the workspace has been swept', () => {
    const session = new OrchestratorSession('c1');
    assert.equal(session.needsSweep, true);
    session.files = [{ path: 'a.ts' } as never];
    assert.equal(session.needsSweep, false);
    // A follow-up turn must not re-sweep.
    session.startTurn();
    assert.equal(session.needsSweep, false);
  });

  test('turn history accumulates and drives the prior-context recap', () => {
    const session = new OrchestratorSession('c1');
    assert.equal(session.priorContext(), '', 'a first turn has no prior context');

    session.intake = { restatedGoal: 'diagnose charging drain' } as never;
    session.recordTurn('2 findings: current not reduced when warm');
    session.startTurn();

    const recap = session.priorContext();
    assert.match(recap, /CONVERSATION SO FAR/);
    assert.match(recap, /diagnose charging drain/);
    assert.match(recap, /current not reduced when warm/);
  });

  test('the recap keeps only the most recent turns, so it cannot grow without bound', () => {
    const session = new OrchestratorSession('c1');
    for (let i = 0; i < 20; i++) {
      session.intake = { restatedGoal: `turn ${i}` } as never;
      session.recordTurn(`did thing ${i}`);
    }
    const recap = session.priorContext();
    assert.match(recap, /turn 19/);
    assert.ok(!recap.includes('turn 0'), 'the oldest turns are dropped from the recap');
  });

  test('redactions accumulate across turns so reveal() works on any turn', () => {
    const session = new OrchestratorSession('c1');
    session.redactions.push({ placeholder: '<IMEI_1>', original: '490154203237518', rule: 'IMEI' });
    session.startTurn();
    // A later turn adds its own.
    session.redactions.push({ placeholder: '<SERIAL_1>', original: 'R5CW90ABCDE', rule: 'device serial' });

    // Output from turn 1's context can still be revealed in a later turn.
    const revealed = session.reveal('device <SERIAL_1> with imei <IMEI_1>');
    assert.match(revealed, /490154203237518/);
    assert.match(revealed, /R5CW90ABCDE/);
  });

  test('taint set on an early turn persists across startTurn', () => {
    const session = new OrchestratorSession('c1');
    session.taint.taintBecause('drivers/knox/policy.c is restricted');
    assert.equal(session.taint.isTainted, true);

    // The whole point: a follow-up turn is still pinned to Gauss, because the
    // conversation history that carried the sensitive content is resent.
    session.startTurn();
    assert.equal(session.taint.isTainted, true);
    assert.match(session.taint.explanation, /knox/);
  });
});
