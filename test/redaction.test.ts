import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { describeRedactions, luhnValid, redactSecrets, restore } from '../src/policy/redact.ts';
import { assessPrompt, SessionTaint } from '../src/planner/promptGuard.ts';
import { codenameRule, DEFAULT_RULES } from '../src/policy/patterns.ts';

/**
 * The chat box is the hole the file-approval gate does not cover. These tests
 * exercise a realistic paste: the dumpstate excerpt a developer drops in when
 * reporting a battery problem.
 */

const DUMPSTATE = `
Build: SM-S928B/DM3Q/dm3q:15/AP3A.240905.015.A2
ro.serialno: R5CW90ABCDE
Device IMEI: 490154203237518
wlan0 HWaddr 3c:5a:b4:1f:2e:9d
account: engineer.kim@partner-corp.com
[  412.883] max77705-charger: chg_curr=450mA temp=48C
[  413.001] sec-battery: capacity dropped 84 -> 79
api_key = "sk_live_9aX2mQ7pL4zR8tN3bW6yK1cF"
`;

describe('redaction', () => {
  test('removes the identifiers a dumpstate carries', () => {
    const result = redactSecrets(DUMPSTATE);

    for (const leaked of [
      'R5CW90ABCDE',
      '490154203237518',
      '3c:5a:b4:1f:2e:9d',
      'engineer.kim@partner-corp.com',
      'sk_live_9aX2mQ7pL4zR8tN3bW6yK1cF',
    ]) {
      assert.ok(!result.text.includes(leaked), `${leaked} must not survive redaction`);
    }
  });

  test('leaves the diagnostic content intact', () => {
    const result = redactSecrets(DUMPSTATE);

    // The whole point is that the log is still readable afterwards.
    assert.match(result.text, /chg_curr=450mA/);
    assert.match(result.text, /capacity dropped 84 -> 79/);
    assert.match(result.text, /max77705-charger/);
  });

  test('the same value gets the same placeholder every time', () => {
    const result = redactSecrets('imei 490154203237518 and again 490154203237518');
    const matches = result.text.match(/<IMEI_\d+>/g) ?? [];

    assert.equal(matches.length, 2);
    assert.equal(matches[0], matches[1]);
    assert.equal(result.redactions.length, 1, 'one value, one redaction entry');
  });

  test('restores the real values for display', () => {
    const result = redactSecrets(DUMPSTATE);
    const finding = `Device ${result.redactions.find((r) => r.rule === 'IMEI')?.placeholder} shows the drop.`;

    assert.match(restore(finding, result.redactions), /490154203237518/);
  });

  test('a 15-digit number that is not an IMEI is left alone', () => {
    // Luhn-invalid: redacting this would corrupt the log we are trying to read.
    assert.equal(luhnValid('123456789012345'), false);
    assert.equal(luhnValid('490154203237518'), true);

    const result = redactSecrets('total bytes written: 123456789012345');
    assert.match(result.text, /123456789012345/);
  });

  test('consumes a private key block whole rather than in fragments', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\nDEF456\n-----END RSA PRIVATE KEY-----';
    const result = redactSecrets(`config:\n${key}\ndone`);

    assert.equal(result.text.includes('MIIEabc123'), false);
    assert.match(result.text, /<PRIVATE_KEY_1>/);
    assert.match(result.text, /^config:/m);
  });

  test('summarises what was removed, so it is never silent', () => {
    const summary = describeRedactions(redactSecrets(DUMPSTATE));
    assert.match(summary, /IMEI|email|MAC/);
  });

  test('leaves ordinary prose untouched', () => {
    const text = 'The charging current drops when the battery gets warm.';
    assert.equal(redactSecrets(text).text, text);
  });
});

describe('prompt guard', () => {
  test('redacts a pasted dumpstate without tainting the run', () => {
    const assessment = assessPrompt(`charging drops fast, here is the log:\n${DUMPSTATE}`);

    assert.ok(assessment.redaction.redactions.length > 0);
    // Identifiers are strippable, so external models remain usable.
    assert.equal(assessment.taint, false);
    assert.match(assessment.summary, /Removed \d+ identifier/);
  });

  test('taints the run when the prompt itself is confidential prose', () => {
    const rules = [...DEFAULT_RULES, codenameRule(['Nightfall'])!];
    const assessment = assessPrompt('why did Nightfall slip to Q3?', { rules });

    // Nothing here is a pattern you can strip — you either send the sentence or
    // you do not.
    assert.equal(assessment.taint, true);
    assert.equal(assessment.tier, 'confidential');
    assert.match(assessment.summary, /stays on Gauss/);
  });

  test('taints on secure-boot vocabulary typed directly into chat', () => {
    const assessment = assessPrompt('the avb_verify_slot path rejects our rollback_index, why?');

    assert.equal(assessment.taint, true);
    assert.equal(assessment.tier, 'restricted');
  });

  test('a pasted credential is stripped, not treated as a reason to taint', () => {
    // Tainting on a redacted secret would punish the developer for pasting a
    // log — and they would go paste it into a browser tab instead.
    const assessment = assessPrompt('it fails with api_key = "sk_live_9aX2mQ7pL4zR8tN3bW6yK1cF"');

    assert.equal(assessment.taint, false);
    assert.ok(!assessment.redaction.text.includes('sk_live_9aX2mQ7pL4zR8tN3bW6yK1cF'));
  });

  test('an ordinary request neither redacts nor taints', () => {
    const assessment = assessPrompt('add retry logic to the upload client');

    assert.equal(assessment.taint, false);
    assert.equal(assessment.redaction.redactions.length, 0);
    assert.equal(assessment.summary, '');
  });
});

describe('session taint', () => {
  test('is sticky: a clean later turn does not clear it', () => {
    const rules = [...DEFAULT_RULES, codenameRule(['Nightfall'])!];
    const taint = new SessionTaint();

    taint.absorb(assessPrompt('tell me about Nightfall', { rules }));
    assert.equal(taint.isTainted, true);

    // Chat history is resent, so turn 3's content is still in turn 12's prompt.
    taint.absorb(assessPrompt('now add a unit test', { rules }));
    assert.equal(taint.isTainted, true);
  });

  test('stays clean when nothing sensitive ever arrives', () => {
    const taint = new SessionTaint();
    taint.absorb(assessPrompt('rename the helper function'));
    taint.absorb(assessPrompt('now add a test for it'));

    assert.equal(taint.isTainted, false);
  });

  test('can be tainted by a scan result, not just the prompt', () => {
    const taint = new SessionTaint();
    taint.taintBecause('drivers/knox/policy.c is restricted');

    assert.equal(taint.isTainted, true);
    assert.match(taint.explanation, /knox/);
  });
});
