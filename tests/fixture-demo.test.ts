/**
 * The fixture demo entry point behind `pnpm run acquire:fixture`.
 *
 * The contract lists that command as verification, so the property under test
 * is that it succeeds on a second consecutive invocation with no cleanup in
 * between — while still leaving a job it did not create alone.
 *
 * The entry point is spawned as a real process, like the CLI suite, so the
 * exit code under test is the one pnpm would see.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { JOB_FILE, JOB_STATE_VERSION } from '../src/job.ts';
import { withTempDirectory } from './helpers/acquisition.ts';

const run = promisify(execFile);
const DEMO = fileURLToPath(new URL('../src/fixture-demo.ts', import.meta.url));

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function demo(directory: string): Promise<Captured> {
  try {
    const { stdout, stderr } = await run(process.execPath, [DEMO, directory]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

test('the fixture demo succeeds on a second consecutive run over its own output', async () => {
  await withTempDirectory(async (directory) => {
    const first = await demo(directory);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /run state\s+complete/u);

    const second = await demo(directory);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /run state\s+complete/u);

    const report = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')) as {
      counts: { recoveredFiles: number };
    };
    assert.equal(report.counts.recoveredFiles, 7);
  });
});

test('the fixture demo refuses a job it did not create and leaves it on disk', async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, JOB_FILE);
    const foreign = { version: JOB_STATE_VERSION, projectId: 'someone-elses-site', items: [] };
    await writeFile(path, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8');

    const result = await demo(directory);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /not the demo-site demo/u);

    const kept = JSON.parse(await readFile(path, 'utf8')) as { projectId: string };
    assert.equal(kept.projectId, 'someone-elses-site');
  });
});
