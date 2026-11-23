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

import { dirname } from 'node:path';

import { runAcquisition, type ControlSignal } from './acquire.ts';
import { DEFAULT_OUTCOME_RESELECTION, loadProjectConfig } from './config.ts';
import { buildEvidenceReport, loadEvidenceRevisions, summarize, writeEvidenceReport } from './evidence.ts';
import { createFixtureTransport, loadFixtureManifest } from './fixture-transport.ts';
import { CODE_REVISION, fixtureRevisionFromPath } from './revision.ts';
import { loadJob, type JobState } from './job.ts';
import { collectionFromJob, loadCollectionManifest, type Collection } from './collection.ts';
import { buildSiteModel, summarizeSiteModel, writeSiteModel } from './site-model.ts';
import {
  buildReferenceBundle,
  loadReferenceBundle,
  signOffReferenceBundle,
  summarizeReferenceBundle,
  verifyReferenceBundle,
  type PageSelection,
} from './reference.ts';
import { createChromiumRenderer } from './render-chromium.ts';
import { evaluateCandidate, summarizeEvaluation } from './evaluate.ts';
import { summarizeGeneration, transcribeSite } from './transcribe.ts';
import type { AnthropicEffort } from './provider-anthropic.ts';
import {
  modernizeSite,
  rewriteBrief,
  submitRewrite,
  summarizeModernization,
  summarizeSubmission,
  DEFAULT_MODERNIZE_BUDGETS,
} from './modernize.ts';
import { reclassifyJob } from './reclassify.ts';
import { DEFAULT_FIDELITY } from './fidelity.ts';
import { DEFAULT_ASSET_RESOLUTION } from './resolve-asset.ts';
import { DEFAULT_SELECTION } from './select.ts';
import { systemResolver } from './destination.ts';
import { createLiveTransport } from './transport.ts';

const USAGE = `resurrection — bounded archive acquisition

  acquire --config <file> --transport <fixture|live> [options]
    --fixture-manifest <file>     required with --transport fixture
    --confirm-live-acquisition    required with --transport live
    --code-revision <id>          identity of the acquiring code (default: the
                                  embedded constant; never read from .git)
    --output <dir>                override the config's outputDirectory
    --resume                      continue an existing job in the output dir
    --retry-failed                requeue retryable failures on resume
    --max-items <n>               stop after n items, to rehearse pause/resume

  report --job <dir>
    Re-render the evidence summary from a job on disk. Makes no requests.

  reclassify --job <dir> [--config <file>]
    Re-run outcome classification and fidelity scoring over bytes already
    stored, then re-render the report. Reads the body store, opens no socket,
    refetches nothing. Without --config the documented default fidelity
    weights, bands and tuning apply and no promotion override is recorded.

  model (--job <dir> | --manifest <file>) [--output <dir>]
    Build the site model from bodies already stored: page inventory, page
    families, asset catalogue, navigation graph and gaps. Opens no socket.
    Writes site-model.json to --output (default: the job directory, or the
    manifest's directory).

  reference (--job <dir> | --manifest <file>) --output <dir> [options]
    Render recovered pages in pinned Chromium with scripts off and every
    request answered from stored bytes, then write a reference bundle:
    screenshots, measured anchors, text and request records. Opens no socket.
    --pages <representatives|all>  default: one page per family
    --viewport <width>x<height>    default: 1024x768

  reference-verify --bundle <dir>
    Re-derive every hash in a bundle and report whether it is frozen.

  reference-signoff --bundle <dir> --by <name> --note <text>
    Record a human approval of exactly this bundle's digest.

  generate (--job <dir> | --manifest <file>) --output <dir>
    Build a candidate site from the recovered markup itself, with no model
    call: local files, relative links, UTF-8, archived scripts removed, and
    missing or external dependencies replaced by labelled placeholders.

  modernize --bundle <dir> --baseline <dir> --output <dir> --confirm-model-spend [options]
    Ask a model to rewrite each referenced page in current HTML and CSS,
    starting from a candidate that already passes. A rewrite replaces the
    baseline page only when the evaluator passes it; otherwise the baseline
    stays. THIS CALLS A PAID MODEL API. It needs --confirm-model-spend and
    credentials in the environment, and it stops at the token budget.
    --model <id>                  default: claude-opus-5-5
    --effort <level>              low|medium|high|xhigh|max, default high
    --max-pages <n>               default: 30
    --max-attempts <n>            per page, default: 3
    --max-input-tokens <n>        default: 2000000
    --max-output-tokens <n>       default: 1000000
    --one-per-family              rewrite only the first page of each page
                                  family, for a small trial
    --allow-unfrozen-reference    as for evaluate

  brief --bundle <dir> --baseline <dir> --page <id|url>
    Print what an author needs to rewrite one page: the rules, the measured
    elements, and where the source and reference screenshot are.

  submit --bundle <dir> --baseline <dir> --output <dir> --page <id|url>
         --file <page.html> --author <name> [--max-attempts <n>]
    Judge one rewritten page, whoever wrote it. It is checked statically and
    then by the evaluator, and replaces the baseline page only on a full
    pass. Calls no model. Exits 0 when accepted.
    --allow-unfrozen-reference    as for evaluate

  evaluate --bundle <dir> --candidate <dir> --output <dir> [options]
    Render a built candidate site under the bundle's conditions and compare
    it with the frozen references: route, title, text, pixels, geometry,
    links and runtime. Writes evaluation.json and difference images. Exits 0
    only when every state passes. Opens no socket.
    --allow-unfrozen-reference    evaluate against a bundle with no sign-off;
                                  the verdict then says nothing is verified
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
  if (command === 'reclassify') return await reclassifyCommand(flags);
  if (command === 'model') return await modelCommand(flags);
  if (command === 'reference') return await referenceCommand(flags);
  if (command === 'reference-verify') return await referenceVerifyCommand(flags);
  if (command === 'reference-signoff') return await referenceSignoffCommand(flags);
  if (command === 'generate') return await generateCommand(flags);
  if (command === 'modernize') return await modernizeCommand(flags);
  if (command === 'brief') return await briefCommand(flags);
  if (command === 'submit') return await submitCommand(flags);
  if (command === 'evaluate') return await evaluateCommand(flags);

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
  let fixtureRevision: string | null = null;
  if (transportName === 'fixture') {
    const manifestPath = flags['fixture-manifest'];
    if (manifestPath === undefined) {
      process.stderr.write('--transport fixture requires --fixture-manifest <file>\n');
      return 1;
    }
    const handle = createFixtureTransport(await loadFixtureManifest(manifestPath));
    transport = handle.transport;
    resolver = handle.resolver;
    fixtureRevision = await fixtureRevisionFromPath(manifestPath);
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
    codeRevision: flags['code-revision'] ?? CODE_REVISION,
    fixtureRevision,
  });

  process.stdout.write(`${summarize(result.report)}\n`);
  process.stdout.write(`evidence       ${result.reportPath}\n`);
  return result.report.counts.recoveredFiles > 0 || result.report.counts.fetched > 0 ? 0 : 2;
}

async function loadCollectionFromFlags(
  command: string,
  flags: Record<string, string>,
): Promise<{ collection: Collection; defaultOutput: string } | null> {
  const jobDirectory = flags['job'];
  const manifestPath = flags['manifest'];
  if ((jobDirectory === undefined) === (manifestPath === undefined)) {
    process.stderr.write(`${command} requires exactly one of --job <dir> or --manifest <file>\n`);
    return null;
  }
  try {
    if (jobDirectory !== undefined) {
      const state = await loadJob(jobDirectory);
      if (state === null) {
        process.stderr.write(`no job found in ${jobDirectory}\n`);
        return null;
      }
      return { collection: await collectionFromJob(state, jobDirectory), defaultOutput: jobDirectory };
    }
    return { collection: await loadCollectionManifest(manifestPath as string), defaultOutput: dirname(manifestPath as string) };
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return null;
  }
}

async function modelCommand(flags: Record<string, string>): Promise<number> {
  const loaded = await loadCollectionFromFlags('model', flags);
  if (loaded === null) return 1;
  const model = await buildSiteModel(loaded.collection);
  const path = await writeSiteModel(flags['output'] ?? loaded.defaultOutput, model);
  process.stdout.write(summarizeSiteModel(model));
  process.stdout.write(`  written to ${path}\n`);
  return 0;
}

async function referenceCommand(flags: Record<string, string>): Promise<number> {
  const output = flags['output'];
  if (output === undefined) {
    process.stderr.write('reference requires --output <dir>\n');
    return 1;
  }
  const selection = flags['pages'] ?? 'representatives';
  if (selection !== 'representatives' && selection !== 'all') {
    process.stderr.write('--pages must be representatives or all\n');
    return 1;
  }
  const viewportMatch = /^(\d{2,5})x(\d{2,5})$/.exec(flags['viewport'] ?? '1024x768');
  if (viewportMatch === null) {
    process.stderr.write('--viewport must look like 1024x768\n');
    return 1;
  }
  const loaded = await loadCollectionFromFlags('reference', flags);
  if (loaded === null) return 1;

  const model = await buildSiteModel(loaded.collection);
  const renderer = await createChromiumRenderer();
  try {
    const bundle = await buildReferenceBundle({
      collection: loaded.collection,
      model,
      renderer,
      outputDirectory: output,
      selection: selection as PageSelection,
      viewport: { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) },
    });
    process.stdout.write(summarizeReferenceBundle(bundle));
    process.stdout.write(`  written to ${output}\n`);
  } finally {
    await renderer.close();
  }
  return 0;
}

async function referenceVerifyCommand(flags: Record<string, string>): Promise<number> {
  const directory = flags['bundle'];
  if (directory === undefined) {
    process.stderr.write('reference-verify requires --bundle <dir>\n');
    return 1;
  }
  const verification = await verifyReferenceBundle(directory);
  const bundle = await loadReferenceBundle(directory);
  process.stdout.write(summarizeReferenceBundle(bundle));
  for (const problem of verification.problems) process.stdout.write(`  PROBLEM ${problem}\n`);
  process.stdout.write(
    verification.frozen
      ? `  frozen: signed off by ${verification.signoff?.signedBy} at ${verification.signoff?.signedAt}\n`
      : `  not frozen: ${verification.ok ? 'no sign-off recorded' : 'bundle does not verify'}\n`,
  );
  return verification.ok ? 0 : 1;
}

async function referenceSignoffCommand(flags: Record<string, string>): Promise<number> {
  const directory = flags['bundle'];
  const signedBy = flags['by'];
  const note = flags['note'];
  if (directory === undefined || signedBy === undefined || signedBy === 'true' || note === undefined || note === 'true') {
    process.stderr.write('reference-signoff requires --bundle <dir> --by <name> --note <text>\n');
    return 1;
  }
  try {
    const signoff = await signOffReferenceBundle(directory, { signedBy, note, signedAt: new Date().toISOString() });
    process.stdout.write(`signed off bundle ${signoff.bundleDigest.slice(0, 12)} by ${signoff.signedBy}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

async function generateCommand(flags: Record<string, string>): Promise<number> {
  const output = flags['output'];
  if (output === undefined) {
    process.stderr.write('generate requires --output <dir>\n');
    return 1;
  }
  const loaded = await loadCollectionFromFlags('generate', flags);
  if (loaded === null) return 1;
  const model = await buildSiteModel(loaded.collection);
  const record = await transcribeSite({ collection: loaded.collection, model, outputDirectory: output });
  process.stdout.write(summarizeGeneration(record));
  process.stdout.write(`  written to ${output}\n`);
  return 0;
}

function positiveInteger(flags: Record<string, string>, name: string, fallback: number): number | null {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function briefCommand(flags: Record<string, string>): Promise<number> {
  const bundleDirectory = flags['bundle'];
  const baselineDirectory = flags['baseline'];
  const page = flags['page'];
  if (bundleDirectory === undefined || baselineDirectory === undefined || page === undefined) {
    process.stderr.write('brief requires --bundle <dir> --baseline <dir> --page <id|url>\n');
    return 1;
  }
  try {
    process.stdout.write(await rewriteBrief(bundleDirectory, baselineDirectory, page));
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

async function submitCommand(flags: Record<string, string>): Promise<number> {
  const bundleDirectory = flags['bundle'];
  const baselineDirectory = flags['baseline'];
  const outputDirectory = flags['output'];
  const page = flags['page'];
  const documentPath = flags['file'];
  const author = flags['author'];
  if ([bundleDirectory, baselineDirectory, outputDirectory, page, documentPath, author].some((value) => value === undefined || value === 'true')) {
    process.stderr.write('submit requires --bundle --baseline --output --page --file --author\n');
    return 1;
  }
  const maxAttempts = positiveInteger(flags, 'max-attempts', DEFAULT_MODERNIZE_BUDGETS.maxAttemptsPerPage);
  if (maxAttempts === null) {
    process.stderr.write('--max-attempts must be a positive integer\n');
    return 1;
  }
  const renderer = await createChromiumRenderer();
  try {
    const result = await submitRewrite({
      bundleDirectory: bundleDirectory as string,
      baselineDirectory: baselineDirectory as string,
      outputDirectory: outputDirectory as string,
      page: page as string,
      documentPath: documentPath as string,
      author: author as string,
      renderer,
      maxAttempts,
      requireFrozenReference: flags['allow-unfrozen-reference'] !== 'true',
    });
    process.stdout.write(summarizeSubmission(result));
    return result.accepted ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  } finally {
    await renderer.close();
  }
}

async function modernizeCommand(flags: Record<string, string>): Promise<number> {
  const bundleDirectory = flags['bundle'];
  const baselineDirectory = flags['baseline'];
  const outputDirectory = flags['output'];
  if (bundleDirectory === undefined || baselineDirectory === undefined || outputDirectory === undefined) {
    process.stderr.write('modernize requires --bundle <dir> --baseline <dir> --output <dir>\n');
    return 1;
  }
  if (flags['confirm-model-spend'] !== 'true') {
    process.stderr.write('modernize calls a paid model API and requires --confirm-model-spend\n');
    return 1;
  }
  const effort = flags['effort'] ?? 'high';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    process.stderr.write('--effort must be low, medium, high, xhigh or max\n');
    return 1;
  }
  const maxPages = positiveInteger(flags, 'max-pages', DEFAULT_MODERNIZE_BUDGETS.maxPages);
  const maxAttemptsPerPage = positiveInteger(flags, 'max-attempts', DEFAULT_MODERNIZE_BUDGETS.maxAttemptsPerPage);
  const maxInputTokens = positiveInteger(flags, 'max-input-tokens', DEFAULT_MODERNIZE_BUDGETS.maxInputTokens);
  const maxOutputTokens = positiveInteger(flags, 'max-output-tokens', DEFAULT_MODERNIZE_BUDGETS.maxOutputTokens);
  if (maxPages === null || maxAttemptsPerPage === null || maxInputTokens === null || maxOutputTokens === null) {
    process.stderr.write('budget options must be positive integers\n');
    return 1;
  }

  // Imported here, behind the confirmation, so no other command can reach a paid API.
  const { createAnthropicProvider } = await import('./provider-anthropic.ts');
  const provider = await createAnthropicProvider({
    ...(flags['model'] === undefined ? {} : { model: flags['model'] }),
    effort: effort as AnthropicEffort,
  });
  let onlyPageIds: string[] | undefined;
  if (flags['one-per-family'] === 'true') {
    const seen = new Set<string>();
    onlyPageIds = [];
    for (const state of (await loadReferenceBundle(bundleDirectory)).states) {
      if (seen.has(state.familyId)) continue;
      seen.add(state.familyId);
      onlyPageIds.push(state.pageId);
    }
  }
  const renderer = await createChromiumRenderer();
  try {
    const record = await modernizeSite({
      bundleDirectory,
      baselineDirectory,
      outputDirectory,
      provider,
      renderer,
      budgets: { maxPages, maxAttemptsPerPage, maxInputTokens, maxOutputTokens },
      ...(onlyPageIds === undefined ? {} : { onlyPageIds }),
      requireFrozenReference: flags['allow-unfrozen-reference'] !== 'true',
    });
    process.stdout.write(summarizeModernization(record));
    process.stdout.write(`  written to ${outputDirectory}\n`);
    return record.finalVerdict === 'fail' ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  } finally {
    await renderer.close();
  }
}

async function evaluateCommand(flags: Record<string, string>): Promise<number> {
  const bundleDirectory = flags['bundle'];
  const candidateDirectory = flags['candidate'];
  const outputDirectory = flags['output'];
  if (bundleDirectory === undefined || candidateDirectory === undefined || outputDirectory === undefined) {
    process.stderr.write('evaluate requires --bundle <dir> --candidate <dir> --output <dir>\n');
    return 1;
  }
  const renderer = await createChromiumRenderer();
  try {
    const report = await evaluateCandidate({
      bundleDirectory,
      candidateDirectory,
      outputDirectory,
      renderer,
      requireFrozenReference: flags['allow-unfrozen-reference'] !== 'true',
    });
    process.stdout.write(summarizeEvaluation(report));
    process.stdout.write(`  written to ${outputDirectory}\n`);
    return report.verdict === 'fail' ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  } finally {
    await renderer.close();
  }
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
  await renderReport(state, directory);
  return 0;
}

async function reclassifyCommand(flags: Record<string, string>): Promise<number> {
  const directory = flags['job'];
  if (directory === undefined) {
    process.stderr.write('reclassify requires --job <dir>\n');
    return 1;
  }
  const existing = await loadJob(directory);
  if (existing === null) {
    process.stderr.write(`no job found in ${directory}\n`);
    return 1;
  }

  const configPath = flags['config'];
  const fidelity = configPath === undefined ? DEFAULT_FIDELITY : (await loadProjectConfig(configPath)).fidelity;

  const { state, summary } = await reclassifyJob(directory, fidelity);
  await renderReport(state, directory, fidelity);
  process.stdout.write(
    `reclassified   ${summary.itemsClassified} items from ${summary.storeReads} stored bodies, ` +
      `0 requests\n`,
  );
  process.stdout.write(
    `scored         ${summary.fidelity.scored} pages; ${summary.fidelity.gatedByOutcome} gated by outcome, ` +
      `${summary.fidelity.nonMarkup} non-markup bodies\n`,
  );
  if (summary.templates.length > 0) {
    process.stdout.write(`templates      ${summary.templates.map((t) => t.id).join(' ')}\n`);
  }
  if (summary.missingBodies > 0) {
    process.stdout.write(`missing bodies ${summary.missingBodies}\n`);
  }
  return 0;
}

/**
 * Render from job state alone. The provider fields are empty because no
 * request is made here and a report never carries operator configuration. The
 * selection policy and the candidate filters are likewise left at their
 * defaults: the report reads what was actually applied off the job's own
 * inventory runs and capture records, not off a config supplied here.
 *
 * Revisions are copied off the existing evidence file when it has them, so a
 * later `report` or `reclassify` names the acquiring code rather than the
 * current tree.
 */
async function renderReport(
  state: JobState,
  directory: string,
  fidelity = DEFAULT_FIDELITY,
): Promise<void> {
  const recorded = await loadEvidenceRevisions(directory);
  const report = buildEvidenceReport(
    state,
    {
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
      selection: DEFAULT_SELECTION,
      outcomeReselection: DEFAULT_OUTCOME_RESELECTION,
      // Each resolved asset carries the window that was actually applied to it;
      // this is only the section-level default for a job that resolved none.
      assetResolution: DEFAULT_ASSET_RESOLUTION,
      // Each score carries its own per-signal weights and its own band
      // thresholds, so the report stays auditable even when this is the default
      // and the job was scored under a project's own policy.
      fidelity,
      candidateFilters: [],
      outputDirectory: directory,
    },
    recorded ?? undefined,
  );
  await writeEvidenceReport(directory, report);
  process.stdout.write(`${summarize(report)}\n`);
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
