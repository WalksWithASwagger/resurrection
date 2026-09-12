/**
 * The fixture demo entry point behind `pnpm run acquire:fixture`.
 *
 * That command is listed in agentic/contract.json under
 * `verification.commands`, so it has to succeed whenever a human runs it, not
 * only on a tree where its output directory happens to be absent.
 *
 * The acquisition core's refusal to overwrite an existing job stays exactly as
 * it is: acquired evidence is never destroyed by a run that did not ask to
 * continue it. This entry point owns one disposable output directory and
 * clears that directory itself before each demo run, and only after confirming
 * the job on disk belongs to the demo project. A job from any other project is
 * left untouched and the demo refuses to run rather than delete work it did
 * not create.
 */

import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { main } from './cli.ts';
import { loadProjectConfig } from './config.ts';
import { loadJob } from './job.ts';

export const DEMO_CONFIG_PATH = fileURLToPath(new URL('../fixtures/demo-site/project.json', import.meta.url));
export const DEMO_MANIFEST_PATH = fileURLToPath(new URL('../fixtures/demo-site/manifest.json', import.meta.url));
export const DEMO_OUTPUT_DIRECTORY = 'tmp/demo-acquisition';

/** Remove a previous demo run's output, and nothing else. */
export async function clearDemoOutput(directory: string): Promise<void> {
  const existing = await loadJob(directory);
  if (existing === null) return;

  const config = await loadProjectConfig(DEMO_CONFIG_PATH);
  if (existing.projectId !== config.projectId) {
    throw new Error(
      `${directory} holds a job for project ${existing.projectId}, not the ${config.projectId} demo; ` +
        'move it aside rather than asking the demo to delete acquired evidence',
    );
  }
  await rm(directory, { recursive: true, force: true });
}

export async function runFixtureDemo(directory: string = DEMO_OUTPUT_DIRECTORY): Promise<number> {
  await clearDemoOutput(directory);
  return await main([
    'acquire',
    '--config',
    DEMO_CONFIG_PATH,
    '--transport',
    'fixture',
    '--fixture-manifest',
    DEMO_MANIFEST_PATH,
    '--output',
    directory,
  ]);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('fixture-demo.ts')) {
  runFixtureDemo(process.argv[2] ?? DEMO_OUTPUT_DIRECTORY)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
