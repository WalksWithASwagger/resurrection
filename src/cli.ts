/**
 * The acquisition CLI.
 *
 * The transport is an explicit argument with no default. `fixture` replays a
 * committed manifest and touches no network. `live` opens real connections to
 * the configured archive provider and additionally requires
 * `--confirm-live-acquisition`, because a live provider call is a
 * human-approved, logged, bounded action under agentic/contract.json
 * (safety.network_isolation), not something a run should be able to do by
 * omitting a flag.
 */

import { runAcquisition, type ControlSignal } from './acquire.ts';
import { loadProjectConfig } from './config.ts';
import { buildEvidenceReport, summarize, writeEvidenceReport } from './evidence.ts';
import { createFixtureTransport, loadFixtureManifest } from './fixture-transport.ts';
import { loadJob } from './job.ts';
import { systemResolver } from './destination.ts';
import { createLiveTransport } from './transport.ts';

const USAGE = `resurrection — bounded archive acquisition

  acquire --config <file> --transport <fixture|live> [options]
    --fixture-manifest <file>     required with --transport fixture
    --confirm-live-acquisition    required with --transport live
    --output <dir>                override the config's outputDirectory
    --resume                      continue an existing job in the output dir
    --retry-failed                requeue retryable failures on resume
    --max-items <n>               stop after n items, to rehearse pause/resume

  report --job <dir>
    Re-render the evidence summary from a job on disk. Makes no requests.
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  if (command === undefined || command === 'help' || flags['help'] === 'true') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === 'acquire') return await acquireCommand(flags);
  if (command === 'report') return await reportCommand(flags);

  process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
  return 1;
}

async function acquireCommand(flags: Record<string, string>): Promise<number> {
  const configPath = flags['config'];
  if (configPath === undefined) {
    process.stderr.write('acquire requires --config <file>\n');
    return 1;
  }
  const transportName = flags['transport'];
  if (transportName !== 'fixture' && transportName !== 'live') {
    process.stderr.write('acquire requires --transport fixture or --transport live\n');
    return 1;
  }

  const config = await loadProjectConfig(configPath);
  const outputDirectory = flags['output'] ?? config.outputDirectory;

  let transport;
  let resolver;
  if (transportName === 'fixture') {
    const manifestPath = flags['fixture-manifest'];
    if (manifestPath === undefined) {
      process.stderr.write('--transport fixture requires --fixture-manifest <file>\n');
      return 1;
    }
    const handle = createFixtureTransport(await loadFixtureManifest(manifestPath));
    transport = handle.transport;
    resolver = handle.resolver;
  } else {
    if (flags['confirm-live-acquisition'] !== 'true') {
      process.stderr.write(
        'a live acquisition is a human-approved, logged, bounded action.\n' +
          'Re-run with --confirm-live-acquisition once that approval exists.\n',
      );
      return 1;
    }
    transport = createLiveTransport();
    resolver = systemResolver;
    process.stderr.write(
      `live acquisition against ${config.provider.allowedHosts.join(', ')} within ` +
        `${config.budgets.maxRequests} requests and ${config.budgets.maxTotalBytes} bytes\n`,
    );
  }

  const maxItems = flags['max-items'] === undefined ? null : Number(flags['max-items']);
  let seen = 0;
  const signal = (): ControlSignal => {
    if (maxItems === null) return 'continue';
    seen += 1;
    return seen > maxItems ? 'pause' : 'continue';
  };

  const result = await runAcquisition({
    config: { ...config, outputDirectory },
    transport,
    resolver,
    resume: flags['resume'] === 'true',
    retryFailed: flags['retry-failed'] === 'true',
    signal,
  });

  process.stdout.write(`${summarize(result.report)}\n`);
  process.stdout.write(`evidence       ${result.reportPath}\n`);
  return result.report.counts.recoveredFiles > 0 || result.report.counts.fetched > 0 ? 0 : 2;
}

async function reportCommand(flags: Record<string, string>): Promise<number> {
  const directory = flags['job'];
  if (directory === undefined) {
    process.stderr.write('report requires --job <dir>\n');
    return 1;
  }
  const state = await loadJob(directory);
  if (state === null) {
    process.stderr.write(`no job found in ${directory}\n`);
    return 1;
  }
  const report = buildEvidenceReport(state, {
    projectId: state.projectId,
    scope: state.scope,
    budgets: state.budgets,
    provider: {
      cdxEndpoint: '',
      replayEndpoint: '',
      allowedHosts: [],
      minRequestIntervalMs: 0,
      requestTimeoutMs: 0,
    },
    discovery: { followRelations: [], followPageLinks: false },
    outputDirectory: directory,
  });
  await writeEvidenceReport(directory, report);
  process.stdout.write(`${summarize(report)}\n`);
  return 0;
}

function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = 'true';
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('cli.ts')) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
