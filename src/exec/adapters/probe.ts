import type { AdapterId } from '../../types/ir.ts';
import { capture } from '../process.ts';
import {
  NO_CAPABILITIES,
  type AdapterCapabilities,
  type ProbeResult,
  type ProbeStatus,
} from './types.ts';

/**
 * Capability detection by help-text inspection.
 *
 * CLI flags drift between versions and we depend on several that carry real
 * money — `--bare`, `--json-schema`, the read-only modes. Rather than assume
 * they exist and discover otherwise mid-run, every adapter declares which flags
 * back which capability and we check at activation.
 *
 * Absence in help text is treated as absence of the capability, which can
 * occasionally be wrong for CLIs that abbreviate their help. That direction of
 * error is the safe one: we fall back to a more expensive but working
 * invocation, and the note explains why.
 */

/** Which flags, if any are present, indicate a capability is available. */
type CapabilitySpec = Partial<Record<keyof AdapterCapabilities, string[]>>;

interface AdapterProbeSpec {
  /** Extra args to reach the relevant help page, e.g. `exec --help`. */
  helpArgs: string[];
  versionArgs: string[];
  capabilities: CapabilitySpec;
  /** Capabilities whose loss makes the adapter unusable rather than degraded. */
  required: (keyof AdapterCapabilities)[];
  /** Capabilities whose loss costs money but still runs. */
  costCritical: (keyof AdapterCapabilities)[];
}

export const PROBE_SPECS: Readonly<Record<Exclude<AdapterId, 'gauss'>, AdapterProbeSpec>> =
  Object.freeze({
    claude: {
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      capabilities: {
        headless: ['-p', '--print'],
        structuredOutput: ['--output-format'],
        outputSchema: ['--json-schema'],
        stripsAgentContext: ['--bare', '--system-prompt'],
        restrictTools: ['--allowedTools', '--disallowedTools', '--permission-mode'],
        modelSelection: ['--model'],
        scopeDirs: ['--add-dir'],
        resume: ['--resume', '--continue'],
        reportsUsage: ['--output-format'],
      },
      required: ['headless', 'structuredOutput'],
      costCritical: ['stripsAgentContext', 'restrictTools', 'outputSchema'],
    },
    codex: {
      versionArgs: ['--version'],
      helpArgs: ['exec', '--help'],
      capabilities: {
        headless: ['exec'],
        structuredOutput: ['--json'],
        outputSchema: ['--output-schema'],
        stripsAgentContext: [],
        restrictTools: ['--sandbox'],
        modelSelection: ['--model', '-m'],
        scopeDirs: ['--cd', '-C'],
        resume: ['resume'],
        reportsUsage: ['--json'],
      },
      required: ['headless'],
      costCritical: ['restrictTools', 'outputSchema'],
    },
    gemini: {
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      capabilities: {
        headless: ['-p', '--prompt'],
        structuredOutput: ['--output-format'],
        outputSchema: [],
        stripsAgentContext: [],
        restrictTools: ['--approval-mode'],
        modelSelection: ['--model', '-m'],
        scopeDirs: ['--include-directories'],
        resume: ['--resume'],
        reportsUsage: ['--output-format'],
      },
      required: ['headless'],
      costCritical: ['restrictTools'],
    },
  });

/**
 * Flags appear in help text as `--bare`, `-p, --print`, `--model <id>`. Match on
 * a boundary so `--model` does not also match `--model-provider`, and `-p` does
 * not match inside `--prompt`.
 */
export function helpMentionsFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,\\[|(])${escaped}(?=$|[\\s,\\]|)=<])`, 'm').test(help);
}

/** Subcommands (`exec`, `resume`) are listed as bare words, not flags. */
function helpMentionsWord(help: string, word: string): boolean {
  return new RegExp(`(^|\\s)${word}(?=$|\\s)`, 'm').test(help);
}

function detect(help: string, flags: string[]): boolean {
  if (flags.length === 0) {
    return false;
  }
  return flags.some((flag) =>
    flag.startsWith('-') ? helpMentionsFlag(help, flag) : helpMentionsWord(help, flag),
  );
}

export function capabilitiesFromHelp(
  help: string,
  spec: CapabilitySpec,
): AdapterCapabilities {
  const caps: AdapterCapabilities = { ...NO_CAPABILITIES };
  for (const [name, flags] of Object.entries(spec) as [
    keyof AdapterCapabilities,
    string[],
  ][]) {
    caps[name] = detect(help, flags);
  }
  return caps;
}

const PROBE_TIMEOUT_MS = 10_000;

export async function probeCli(
  adapter: Exclude<AdapterId, 'gauss'>,
  bin: string,
): Promise<ProbeResult> {
  const spec = PROBE_SPECS[adapter];
  const probedAt = new Date().toISOString();
  const notes: string[] = [];

  const version = await capture(bin, spec.versionArgs, { timeoutMs: PROBE_TIMEOUT_MS });

  if (version.spawnError) {
    return {
      adapter,
      status: 'unavailable',
      bin,
      capabilities: { ...NO_CAPABILITIES },
      notes: [
        `Could not run \`${bin}\`: ${version.spawnError}. Install the CLI or set orchestrator.adapters.${adapter}.path.`,
      ],
      probedAt,
    };
  }
  if (version.timedOut) {
    return {
      adapter,
      status: 'unavailable',
      bin,
      capabilities: { ...NO_CAPABILITIES },
      notes: [`\`${bin} ${spec.versionArgs.join(' ')}\` timed out after ${PROBE_TIMEOUT_MS}ms.`],
      probedAt,
    };
  }

  const help = await capture(bin, spec.helpArgs, { timeoutMs: PROBE_TIMEOUT_MS });
  // Some CLIs write help to stderr, some to stdout. Read both.
  const helpText = `${help.stdout}\n${help.stderr}`;
  const capabilities = capabilitiesFromHelp(helpText, spec.capabilities);

  if (helpText.trim().length === 0) {
    notes.push(
      `\`${bin} ${spec.helpArgs.join(' ')}\` produced no output, so capabilities could not be detected. Falling back to the most conservative invocation.`,
    );
  }

  const missingRequired = spec.required.filter((cap) => !capabilities[cap]);
  const missingCostCritical = spec.costCritical.filter((cap) => !capabilities[cap]);

  for (const cap of missingCostCritical) {
    notes.push(COST_NOTES[cap] ?? `${cap} unavailable; runs will cost more than planned.`);
  }

  let status: ProbeStatus = 'ready';
  if (missingRequired.length > 0) {
    status = 'unavailable';
    notes.unshift(
      `Missing required capability: ${missingRequired.join(', ')}. This adapter cannot be used for execution.`,
    );
  } else if (missingCostCritical.length > 0) {
    status = 'degraded';
  }

  return {
    adapter,
    status,
    bin,
    version: version.stdout.trim() || undefined,
    capabilities,
    notes,
    probedAt,
  };
}

/** Explains what each lost capability costs, since the number is not obvious. */
const COST_NOTES: Partial<Record<keyof AdapterCapabilities, string>> = {
  stripsAgentContext:
    'Cannot strip the CLI\'s own system prompt and project context (--bare / --system-prompt). Every call will carry several thousand extra input tokens.',
  restrictTools:
    'Cannot deny tools, so the agent may explore the repo on its own and pull in context the planner deliberately excluded. This is the single largest source of unplanned spend.',
  outputSchema:
    'Cannot constrain output to a schema, so responses will carry preamble and summary padding. Output tokens cost several times input.',
  scopeDirs: 'Cannot scope the run to a directory subset; the whole workspace is visible.',
  resume: 'Cannot resume sessions, so sequential subtasks will miss the provider prompt cache.',
};

export async function probeAll(
  bins: Record<Exclude<AdapterId, 'gauss'>, string>,
): Promise<ProbeResult[]> {
  const ids = Object.keys(PROBE_SPECS) as Exclude<AdapterId, 'gauss'>[];
  return Promise.all(ids.map((id) => probeCli(id, bins[id])));
}
