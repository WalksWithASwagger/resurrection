/**
 * The fixture reclassify entry point behind `pnpm run reclassify:fixture`.
 *
 * That command is listed in agentic/contract.json under
 * `verification.commands` after acquire:fixture. It re-runs outcome
 * classification over bytes that run already stored. Running it alone on a
 * clean tree used to fail with a bare "no job found" and no hint that
 * acquire:fixture had to run first (issue #24).
 *
 * The smaller fix is this dedicated entry point: when the demo job is
 * absent it names `pnpm run acquire:fixture` as the prerequisite. Generic
 * `reclassify --job` is unchanged. The contract's verification.note is
 * left alone because the ordering guarantee does not change — this
 * command still classifies bytes acquire:fixture stored.
 */

import { main } from './cli.ts';
import { DEMO_OUTPUT_DIRECTORY } from './fixture-demo.ts';
import { loadJob } from './job.ts';

export async function runFixtureReclassify(
  directory: string = DEMO_OUTPUT_DIRECTORY,
): Promise<number> {
  const state = await loadJob(directory);
  if (state === null) {
    throw new Error(
      `no job found in ${directory}; run \`pnpm run acquire:fixture\` first ` +
        `to create the fixture job this command reclassifies`,
    );
  }
  return await main(['reclassify', '--job', directory]);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('fixture-reclassify.ts')) {
  runFixtureReclassify(process.argv[2] ?? DEMO_OUTPUT_DIRECTORY)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
