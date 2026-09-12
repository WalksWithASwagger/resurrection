/**
 * Shared setup for the acquisition suite.
 *
 * Every helper here runs against the committed fixture manifest and a
 * throwaway output directory. Nothing in this file, or anything it constructs,
 * can open a socket: the transport is the fixture replayer and name resolution
 * comes from the manifest's declared addresses.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTestClock } from '../../src/clock.ts';
import { loadProjectConfig, type ProjectConfig } from '../../src/config.ts';
import {
  createFixtureTransport,
  loadFixtureManifest,
  type FixtureManifest,
  type FixtureTransportHandle,
} from '../../src/fixture-transport.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/demo-site/', import.meta.url));
const OUTCOME_ROOT = fileURLToPath(new URL('../../fixtures/outcome-site/', import.meta.url));
const REPLAY_ROOT = fileURLToPath(new URL('../../fixtures/replay-site/', import.meta.url));
const ASSET_ROOT = fileURLToPath(new URL('../../fixtures/asset-site/', import.meta.url));

export const MANIFEST_PATH = join(FIXTURE_ROOT, 'manifest.json');
export const PROJECT_PATH = join(FIXTURE_ROOT, 'project.json');

/** The mixed collection behind the outcome suite: mostly bytes, little content. */
export const OUTCOME_MANIFEST_PATH = join(OUTCOME_ROOT, 'manifest.json');
export const OUTCOME_PROJECT_PATH = join(OUTCOME_ROOT, 'project.json');

/** A fixed start time, so every ISO timestamp in a report is deterministic. */
export const FIXTURE_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

export async function demoManifest(): Promise<FixtureManifest> {
  return await loadFixtureManifest(MANIFEST_PATH);
}

export async function demoConfig(outputDirectory: string): Promise<ProjectConfig> {
  const config = await loadProjectConfig(PROJECT_PATH);
  return { ...config, outputDirectory };
}

export async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'resurrection-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface Harness {
  config: ProjectConfig;
  handle: FixtureTransportHandle;
  clock: ReturnType<typeof createTestClock>;
}

export async function harness(directory: string, manifest?: FixtureManifest): Promise<Harness> {
  return {
    config: await demoConfig(directory),
    handle: createFixtureTransport(manifest ?? (await demoManifest())),
    clock: createTestClock(FIXTURE_EPOCH),
  };
}

export async function outcomeManifest(): Promise<FixtureManifest> {
  return await loadFixtureManifest(OUTCOME_MANIFEST_PATH);
}

export async function outcomeHarness(directory: string, manifest?: FixtureManifest): Promise<Harness> {
  const config = await loadProjectConfig(OUTCOME_PROJECT_PATH);
  return {
    config: { ...config, outputDirectory: directory },
    handle: createFixtureTransport(manifest ?? (await outcomeManifest())),
    clock: createTestClock(FIXTURE_EPOCH),
  };
}

/** The replay-modifier, timeline and selection collection behind issue #7. */
export const REPLAY_MANIFEST_PATH = join(REPLAY_ROOT, 'manifest.json');
export const REPLAY_PROJECT_PATH = join(REPLAY_ROOT, 'project.json');

export async function replayHarness(directory: string, manifest?: FixtureManifest): Promise<Harness> {
  const config = await loadProjectConfig(REPLAY_PROJECT_PATH);
  return {
    config: { ...config, outputDirectory: directory },
    handle: createFixtureTransport(manifest ?? (await loadFixtureManifest(REPLAY_MANIFEST_PATH))),
    clock: createTestClock(FIXTURE_EPOCH),
  };
}

/** The collection behind issue #6: assets whose captures are not their page's. */
export const ASSET_MANIFEST_PATH = join(ASSET_ROOT, 'manifest.json');
export const ASSET_PROJECT_PATH = join(ASSET_ROOT, 'project.json');

export async function assetHarness(directory: string, manifest?: FixtureManifest): Promise<Harness> {
  const config = await loadProjectConfig(ASSET_PROJECT_PATH);
  return {
    config: { ...config, outputDirectory: directory },
    handle: createFixtureTransport(manifest ?? (await loadFixtureManifest(ASSET_MANIFEST_PATH))),
    clock: createTestClock(FIXTURE_EPOCH),
  };
}

/** URLs the fixture transport was actually asked for, in order. */
export function requestedUrls(handle: FixtureTransportHandle): string[] {
  return handle.calls.map((call) => call.url);
}
