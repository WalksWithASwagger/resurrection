/**
 * Code and fixture revisions written into the evidence report (issue #21, R5).
 *
 * The code identity is an embedded constant, not a runtime git lookup. A
 * packaged or checked-out tree may have no `.git`, and rebuilding a report
 * for a cached collection must name the code that produced the collection,
 * not whatever HEAD happens to be now.
 *
 * Override the constant for one invocation with `--code-revision` or
 * `AcquisitionOptions.codeRevision`. Passing a commit SHA there is how a
 * published or live run names the tree it was built from.
 *
 * The fixture identity is the SHA-256 of the manifest file bytes, or null
 * when the run used no fixture. Hashing is local and costs no request.
 */

import { readFile } from 'node:fs/promises';

import { sha256 } from './store.ts';

/**
 * Default recorded when the caller does not name a revision.
 *
 * This is package identity, not HEAD: reading `.git` at report time would
 * make two evaluations of the same collection disagree after an unrelated
 * commit. Tests pin the report against this same export.
 */
export const CODE_REVISION = 'resurrection@0.0.0';

export interface EvidenceRevisions {
  /** Identity of the acquiring code. Never a runtime git lookup. */
  code: string;
  /**
   * SHA-256 of the fixture manifest that produced this run, or null when
   * the run used no fixture (a live-transport acquisition).
   */
  fixture: string | null;
}

export function defaultRevisions(
  overrides: Partial<EvidenceRevisions> = {},
): EvidenceRevisions {
  return {
    code: overrides.code === undefined ? CODE_REVISION : overrides.code,
    fixture: overrides.fixture === undefined ? null : overrides.fixture,
  };
}

/** SHA-256 of exactly the bytes a fixture manifest file holds. */
export function fixtureRevisionOf(bytes: Uint8Array): string {
  return sha256(bytes);
}

export async function fixtureRevisionFromPath(path: string): Promise<string> {
  return fixtureRevisionOf(await readFile(path));
}
