import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  capabilitiesFromHelp,
  helpMentionsFlag,
  probeCli,
  PROBE_SPECS,
} from '../src/exec/adapters/probe.ts';

/**
 * Adapters are exercised against a fake CLI — a shell script that prints canned
 * help and JSON. Real CLI calls in the test suite would cost tokens and would
 * make the suite depend on three vendors' availability.
 */
function fakeCli(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-probe-'));
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('flag detection', () => {
  test('matches flags at token boundaries', () => {
    const help = '  -p, --print              Non-interactive\n      --model <id>         Model\n';
    assert.equal(helpMentionsFlag(help, '--print'), true);
    assert.equal(helpMentionsFlag(help, '-p'), true);
    assert.equal(helpMentionsFlag(help, '--model'), true);
  });

  test('does not match a flag that is only a prefix of another', () => {
    const help = '      --model-provider <id>   Provider\n      --prompt <text>\n';
    assert.equal(helpMentionsFlag(help, '--model'), false);
    // -p must not match inside --prompt.
    assert.equal(helpMentionsFlag(help, '-p'), false);
  });

  test('maps real Claude help text onto capabilities', () => {
    const help = [
      '  -p, --print                     Print response and exit',
      '      --bare                      Skip auto-discovery',
      '      --output-format <format>    text, json, stream-json',
      '      --json-schema <schema>      Constrain output',
      '      --system-prompt <text>      Replace the system prompt',
      '      --allowedTools <tools...>   Auto-approve tools',
      '      --permission-mode <mode>    default, plan, dontAsk',
      '      --model <model>             Model alias or id',
      '      --add-dir <dirs...>         Additional directories',
      '      --resume [sessionId]        Resume a session',
    ].join('\n');

    const caps = capabilitiesFromHelp(help, PROBE_SPECS.claude.capabilities);

    assert.equal(caps.headless, true);
    assert.equal(caps.stripsAgentContext, true);
    assert.equal(caps.outputSchema, true);
    assert.equal(caps.restrictTools, true);
    assert.equal(caps.scopeDirs, true);
    assert.equal(caps.resume, true);
  });

  test('detects subcommands, not just flags', () => {
    const help = 'Commands:\n  exec   Run non-interactively\n  resume Resume a thread\n';
    const caps = capabilitiesFromHelp(help, PROBE_SPECS.codex.capabilities);
    assert.equal(caps.headless, true);
    assert.equal(caps.resume, true);
  });
});

describe('probeCli', () => {
  test('reports unavailable, with a fix, when the binary is missing', async () => {
    const result = await probeCli('claude', '/nonexistent/claude-binary');

    assert.equal(result.status, 'unavailable');
    assert.equal(result.capabilities.headless, false);
    assert.match(result.notes.join(' '), /orchestrator\.adapters\.claude\.path/);
  });

  test('reports ready when every cost-critical capability is present', async () => {
    const bin = fakeCli(
      'claude',
      `case "$1" in
  --version) echo "2.1.214 (Claude Code)" ;;
  *) echo "  -p, --print"
     echo "      --bare"
     echo "      --output-format <f>"
     echo "      --json-schema <s>"
     echo "      --allowedTools <t>"
     echo "      --model <m>" ;;
esac`,
    );

    const result = await probeCli('claude', bin);

    assert.equal(result.status, 'ready');
    assert.equal(result.version, '2.1.214 (Claude Code)');
    assert.deepEqual(result.notes, []);
  });

  test('degrades, and explains the cost, when tool restriction is missing', async () => {
    const bin = fakeCli(
      'claude',
      `case "$1" in
  --version) echo "0.9.0" ;;
  *) echo "  -p, --print"
     echo "      --output-format <f>" ;;
esac`,
    );

    const result = await probeCli('claude', bin);

    assert.equal(result.status, 'degraded');
    const notes = result.notes.join(' ');
    assert.match(notes, /explore the repo on its own/);
    assert.match(notes, /--bare/);
  });

  test('is unavailable when a required capability is absent', async () => {
    const bin = fakeCli('claude', 'echo "usage: claude"');

    const result = await probeCli('claude', bin);

    assert.equal(result.status, 'unavailable');
    assert.match(result.notes[0] ?? '', /Missing required capability/);
  });

  test('reads help from stderr as well as stdout', async () => {
    const bin = fakeCli(
      'gemini',
      `case "$1" in
  --version) echo "1.0.0" ;;
  *) echo "  -p, --prompt <text>" 1>&2
     echo "  -o, --output-format <f>" 1>&2
     echo "      --approval-mode <m>" 1>&2 ;;
esac`,
    );

    const result = await probeCli('gemini', bin);

    assert.equal(result.status, 'ready');
    assert.equal(result.capabilities.headless, true);
  });
});
