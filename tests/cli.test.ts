/**
 * The CLI surface, including the gate in front of a live acquisition.
 *
 * The CLI is spawned as a real process rather than called in-process: that
 * exercises the actual entry point and its exit code, and it keeps the test
 * runner's own stdout out of the assertions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { MANIFEST_PATH, PROJECT_PATH, withTempDirectory } from './helpers/acquisition.ts';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[]): Promise<Captured> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

test('a live acquisition is refused without explicit confirmation', async () => {
  const result = await cli(['acquire', '--config', PROJECT_PATH, '--transport', 'live']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /human-approved, logged, bounded action/u);
  assert.equal(result.stdout, '');
});

test('the transport must be named; there is no default', async () => {
  const result = await cli(['acquire', '--config', PROJECT_PATH]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--transport fixture or --transport live/u);
});

test('a fixture transport needs its manifest', async () => {
  const result = await cli(['acquire', '--config', PROJECT_PATH, '--transport', 'fixture']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--fixture-manifest/u);
});

test('a fixture acquisition runs end to end and writes a portable report', async () => {
  await withTempDirectory(async (directory) => {
    const result = await cli([
      'acquire',
      '--config',
      PROJECT_PATH,
      '--transport',
      'fixture',
      '--fixture-manifest',
      MANIFEST_PATH,
      '--output',
      directory,
    ]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /run state\s+complete/u);
    assert.match(result.stdout, /recovered\s+7 files with validated bytes/u);

    const report = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')) as {
      counts: { fetched: number; recoveredFiles: number };
    };
    assert.equal(report.counts.fetched, 7);
    assert.equal(report.counts.recoveredFiles, 7);
  });
});

test('a run can be stopped after a fixed number of items and reported afterwards', async () => {
  await withTempDirectory(async (directory) => {
    const acquired = await cli([
      'acquire',
      '--config',
      PROJECT_PATH,
      '--transport',
      'fixture',
      '--fixture-manifest',
      MANIFEST_PATH,
      '--output',
      directory,
      '--max-items',
      '2',
    ]);
    assert.match(acquired.stdout, /run state\s+paused/u);

    const reported = await cli(['report', '--job', directory]);

    assert.equal(reported.code, 0);
    assert.match(reported.stdout, /run state\s+paused/u);
    assert.match(reported.stdout, /unattempted\s+[1-9]/u);
  });
});

test('report refuses a directory that holds no job', async () => {
  await withTempDirectory(async (directory) => {
    const result = await cli(['report', '--job', directory]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no job found/u);
  });
});

test('reclassify re-runs classification over stored bytes and reports zero requests', async () => {
  await withTempDirectory(async (directory) => {
    await cli([
      'acquire',
      '--config',
      PROJECT_PATH,
      '--transport',
      'fixture',
      '--fixture-manifest',
      MANIFEST_PATH,
      '--output',
      directory,
    ]);

    const first = await cli(['reclassify', '--job', directory]);
    const second = await cli(['reclassify', '--job', directory]);

    assert.equal(first.code, 0);
    assert.match(first.stdout, /reclassified\s+10 items from 8 stored bodies, 0 requests/u);
    assert.match(first.stdout, /eligible\s+7 of those may become an M2 reference/u);
    // The command is in the contract's verification list, so running it twice
    // in one working tree has to leave the same result (issue #13).
    assert.equal(second.stdout, first.stdout);
  });
});

test('reclassify refuses a directory that holds no job', async () => {
  await withTempDirectory(async (directory) => {
    const result = await cli(['reclassify', '--job', directory]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no job found/u);
  });
});
