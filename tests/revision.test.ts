/**
 * Code and fixture revisions on the evidence report (issue #21, R5).
 *
 * The report must name the acquiring code and, when a fixture produced the
 * run, that fixture. Neither field is a runtime git lookup: a later commit
 * must not rewrite the identity of an already-acquired collection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildEvidenceReport,
  CODE_REVISION,
  EVIDENCE_SCHEMA_VERSION,
  fixtureRevisionFromPath,
  fixtureRevisionOf,
  loadEvidenceRevisions,
  runAcquisition,
  type EvidenceReport,
} from '../src/index.ts';
import {
  harness,
  MANIFEST_PATH,
  OUTCOME_MANIFEST_PATH,
  PROJECT_PATH,
  withTempDirectory,
} from './helpers/acquisition.ts';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('the evidence report records the code revision the harness itself expects', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await harness(directory);
    const result = await runAcquisition({
      config: setup.config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
      codeRevision: CODE_REVISION,
      fixtureRevision: await fixtureRevisionFromPath(MANIFEST_PATH),
    });

    assert.equal(result.report.schemaVersion, EVIDENCE_SCHEMA_VERSION);
    assert.equal(result.report.revisions.code, CODE_REVISION);
    assert.equal(result.report.revisions.code, 'resurrection@0.0.0');
  });
});

test('a fixture-manifest revision changes when the bytes change and stays put when they do not', async () => {
  const original = await readFile(MANIFEST_PATH);
  const samePath = await fixtureRevisionFromPath(MANIFEST_PATH);
  const sameBytes = fixtureRevisionOf(original);
  const other = await fixtureRevisionFromPath(OUTCOME_MANIFEST_PATH);
  const mutated = fixtureRevisionOf(Buffer.concat([original, Buffer.from('\n')]));

  assert.match(samePath, /^[0-9a-f]{64}$/u);
  assert.equal(samePath, sameBytes);
  assert.notEqual(samePath, other);
  assert.notEqual(samePath, mutated);

  await withTempDirectory(async (directory) => {
    const setup = await harness(directory);
    const first = await runAcquisition({
      config: setup.config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
      fixtureRevision: samePath,
    });
    assert.equal(first.report.revisions.fixture, samePath);

    const again = await withTempDirectory(async (secondDirectory) => {
      const secondSetup = await harness(secondDirectory);
      const second = await runAcquisition({
        config: secondSetup.config,
        transport: secondSetup.handle.transport,
        resolver: secondSetup.handle.resolver,
        clock: secondSetup.clock,
        fixtureRevision: sameBytes,
      });
      return second.report.revisions.fixture;
    });
    assert.equal(again, first.report.revisions.fixture);

    const changed = await withTempDirectory(async (thirdDirectory) => {
      const thirdSetup = await harness(thirdDirectory);
      const third = await runAcquisition({
        config: thirdSetup.config,
        transport: thirdSetup.handle.transport,
        resolver: thirdSetup.handle.resolver,
        clock: thirdSetup.clock,
        fixtureRevision: mutated,
      });
      return third.report.revisions.fixture;
    });
    assert.equal(changed, mutated);
    assert.notEqual(changed, first.report.revisions.fixture);
  });
});

test('a live-transport path records fixture revision as null, not omitted or fabricated', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await harness(directory);
    // The library live path is the same function the CLI calls after it
    // refuses to invent a fixture hash: fixtureRevision is null, and no
    // live transport is constructed (tests/isolation.test.ts).
    const result = await runAcquisition({
      config: setup.config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
      fixtureRevision: null,
    });

    assert.equal(result.report.revisions.fixture, null);
    assert.equal(Object.hasOwn(result.report.revisions, 'fixture'), true);

    const raw = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')) as {
      revisions: { code: string; fixture: string | null };
    };
    assert.equal(raw.revisions.fixture, null);
    assert.equal('fixture' in raw.revisions, true);
    assert.notEqual(raw.revisions.fixture, undefined);
    assert.doesNotMatch(raw.revisions.fixture ?? '', /^[0-9a-f]{64}$/u);

    const rebuilt = buildEvidenceReport(result.state, setup.config);
    assert.equal(rebuilt.revisions.fixture, null);
    assert.equal(Object.hasOwn(rebuilt.revisions, 'fixture'), true);
  });
});

test('recomputing evidence for a cached collection reuses the recorded revision', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await harness(directory);
    const acquiredAt = 'acquired-at-aaa111';
    const fixture = await fixtureRevisionFromPath(MANIFEST_PATH);
    const first = await runAcquisition({
      config: setup.config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
      codeRevision: acquiredAt,
      fixtureRevision: fixture,
    });
    assert.equal(first.report.revisions.code, acquiredAt);

    // As if HEAD had moved on. Rebuilds must not pick this up.
    const recorded = await loadEvidenceRevisions(directory);
    assert.deepEqual(recorded, { code: acquiredAt, fixture });
    const rebuilt = buildEvidenceReport(first.state, setup.config, recorded ?? { code: 'head-moved-on', fixture: null });
    assert.equal(rebuilt.revisions.code, acquiredAt);
    assert.equal(rebuilt.revisions.fixture, fixture);

    const resumed = await runAcquisition({
      config: setup.config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
      resume: true,
      codeRevision: 'head-moved-on',
      fixtureRevision: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    });
    assert.equal(resumed.report.revisions.code, acquiredAt);
    assert.equal(resumed.report.revisions.fixture, fixture);

    const reported = await run(process.execPath, [CLI, 'report', '--job', directory]);
    assert.match(reported.stdout, new RegExp(`code ${acquiredAt}`, 'u'));
    const afterReport = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')) as EvidenceReport;
    assert.equal(afterReport.revisions.code, acquiredAt);
    assert.equal(afterReport.revisions.fixture, fixture);
  });
});

test('the fixture CLI hashes the manifest file and accepts --code-revision', async () => {
  await withTempDirectory(async (directory) => {
    const expectedFixture = await fixtureRevisionFromPath(MANIFEST_PATH);
    const { stdout } = await run(process.execPath, [
      CLI,
      'acquire',
      '--config',
      PROJECT_PATH,
      '--transport',
      'fixture',
      '--fixture-manifest',
      MANIFEST_PATH,
      '--output',
      directory,
      '--code-revision',
      'cli-named-commit',
    ]);

    assert.match(stdout, /code cli-named-commit/u);
    assert.match(stdout, new RegExp(`fixture ${expectedFixture}`, 'u'));

    const report = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')) as EvidenceReport;
    assert.equal(report.revisions.code, 'cli-named-commit');
    assert.equal(report.revisions.fixture, expectedFixture);
  });
});

test('a report file with no revisions object is treated as unrecorded, not fabricated', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, 'evidence.json'), `${JSON.stringify({ projectId: 'demo-site' }, null, 2)}\n`, 'utf8');
    assert.equal(await loadEvidenceRevisions(directory), null);
  });
});
