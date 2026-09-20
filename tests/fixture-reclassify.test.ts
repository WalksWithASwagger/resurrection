/**
 * The fixture reclassify entry point behind `pnpm run reclassify:fixture`.
 *
 * Issue #24: running that command alone on a clean tree must fail with a
 * message that names `pnpm run acquire:fixture`, not a bare "no job found".
 * The generic CLI reclassify path, and the acquire-then-reclassify ordering
 * assertions, are unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { withTempDirectory } from './helpers/acquisition.ts';

const run = promisify(execFile);
const RECLASSIFY = fileURLToPath(new URL('../src/fixture-reclassify.ts', import.meta.url));
const DEMO = fileURLToPath(new URL('../src/fixture-demo.ts', import.meta.url));

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function spawn(script: string, directory: string): Promise<Captured> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, directory]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

test('fixture reclassify alone on a clean tree names acquire:fixture', async () => {
  await withTempDirectory(async (directory) => {
    const first = await spawn(RECLASSIFY, directory);
    const second = await spawn(RECLASSIFY, directory);

    assert.equal(first.code, 1);
    assert.match(first.stderr, /no job found/u);
    assert.match(first.stderr, /pnpm run acquire:fixture/u);
    assert.equal(first.stdout, '');

    // Twice in a row is the same named-command error, not a different failure.
    assert.equal(second.code, 1);
    assert.equal(second.stderr, first.stderr);
  });
});

test('fixture reclassify succeeds twice over a job acquire:fixture just wrote', async () => {
  await withTempDirectory(async (directory) => {
    const acquired = await spawn(DEMO, directory);
    assert.equal(acquired.code, 0);

    const first = await spawn(RECLASSIFY, directory);
    const second = await spawn(RECLASSIFY, directory);

    assert.equal(first.code, 0);
    assert.match(first.stdout, /reclassified/u);
    assert.equal(second.stdout, first.stdout);
  });
});
