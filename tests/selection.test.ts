/**
 * Capture selection policy.
 *
 * The decisive case is a capture set where `nearest` and `earliest-largest`
 * choose differently. Anything else can pass by coincidence: if both policies
 * would land on the same capture, a test proves only that some capture was
 * picked, not that the declared policy was the thing that picked it.
 *
 * Every timestamp here is synthetic and every URL is under the reserved
 * .invalid TLD.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectCapture,
  selectionTarget,
  expandTimestamp,
  CAPTURE_SELECTION_POLICIES,
  DEFAULT_SELECTION,
  type CaptureCandidate,
  type SelectionConfig,
} from '../src/index.ts';

const capture = (timestamp: string, length: number, excludedBy: string | null = null): CaptureCandidate => ({
  timestamp,
  digest: `D${timestamp}`,
  statusCode: excludedBy === null ? '200' : '404',
  mimetype: 'text/html',
  length,
  excludedBy,
});

const NEAREST: SelectionConfig = { policy: 'nearest', clusterWindowDays: 90 };
const EARLIEST_LARGEST: SelectionConfig = { policy: 'earliest-largest', clusterWindowDays: 90 };

/**
 * A dead site's capture history. Two captures cluster in early 1998, the site
 * thins out, and the last capture inside the declared period is a small, late,
 * link-rotted page. The policies must disagree about this set.
 */
const DISAGREEING_SET: CaptureCandidate[] = [
  capture('19980112000000', 4200),
  capture('19980220000000', 9100),
  capture('19981101000000', 6000),
  capture('19991220000000', 800),
];

test('the two policies disagree on this set, which is what makes the rest meaningful', () => {
  const nearest = selectCapture(DISAGREEING_SET, NEAREST, expandTimestamp('1999', 'end'));
  const earliest = selectCapture(DISAGREEING_SET, EARLIEST_LARGEST, expandTimestamp('1999', 'end'));

  assert.notEqual(nearest?.timestamp, earliest?.timestamp);
});

test('nearest takes the capture closest to the declared bound, not the biggest body', () => {
  const selection = selectCapture(DISAGREEING_SET, NEAREST, expandTimestamp('1999', 'end'));

  assert.equal(selection?.timestamp, '19991220000000');
  assert.equal(selection?.policy, 'nearest');
  assert.equal(selection?.target, '19991231235959');
  assert.equal(selection?.consideredCount, 4);
  assert.match(selection?.reason ?? '', /nearest to the declared bound 19991231235959/u);
});

test('earliest-largest takes the largest body inside the earliest cluster', () => {
  const selection = selectCapture(DISAGREEING_SET, EARLIEST_LARGEST, expandTimestamp('1999', 'end'));

  // The 1998-11 capture is larger than the 1998-01 one but falls outside the
  // 90-day window, so the cluster is the two January/February captures.
  assert.equal(selection?.timestamp, '19980220000000');
  assert.equal(selection?.policy, 'earliest-largest');
  assert.equal(selection?.target, null);
  assert.match(selection?.reason ?? '', /largest of the 2 capture\(s\) within 90 days/u);
});

test('widening the cluster window changes which captures count as one era', () => {
  const wide: SelectionConfig = { policy: 'earliest-largest', clusterWindowDays: 400 };

  const selection = selectCapture(DISAGREEING_SET, wide, null);

  assert.equal(selection?.timestamp, '19980220000000');
  assert.match(selection?.reason ?? '', /within 400 days/u);
});

test('a project with no declared period has no target and takes the latest capture', () => {
  const selection = selectCapture(DISAGREEING_SET, NEAREST, null);

  assert.equal(selection?.timestamp, '19991220000000');
  assert.match(selection?.reason ?? '', /declares no period to aim at/u);
});

test('the declared period end is the target, and a period start is the fallback', () => {
  assert.equal(selectionTarget({ from: '1998', to: '1999' }), '19991231235959');
  assert.equal(selectionTarget({ from: '1998', to: null }), '19980101000000');
  assert.equal(selectionTarget({ from: null, to: null }), null);
});

test('a prefix timestamp expands to the first or last instant it covers', () => {
  assert.equal(expandTimestamp('1999', 'start'), '19990101000000');
  assert.equal(expandTimestamp('1999', 'end'), '19991231235959');
  assert.equal(expandTimestamp('199902', 'end'), '19990228235959', 'February 1999 has 28 days');
  assert.equal(expandTimestamp('200002', 'end'), '20000229235959', '2000 is a leap year');
  assert.equal(expandTimestamp('19990315120000', 'end'), '19990315120000');
});

test('an excluded capture is never chosen while the URL has an eligible one', () => {
  const mixed = [capture('19990101000000', 5000, 'statuscode:200'), capture('19980101000000', 100)];

  const selection = selectCapture(mixed, NEAREST, expandTimestamp('1999', 'end'));

  assert.equal(selection?.timestamp, '19980101000000');
  assert.equal(selection?.fromExcludedCapture, false);
  assert.equal(selection?.consideredCount, 1, 'only eligible captures are in the pool');
});

test('a URL whose every capture is excluded is still selected, and says so', () => {
  // Dropping it would delete the origin's own error page, which is the one
  // thing that establishes a site error template for soft-404 detection.
  const onlyExcluded = [capture('19990101000000', 900, 'statuscode:200')];

  const selection = selectCapture(onlyExcluded, NEAREST, expandTimestamp('1999', 'end'));

  assert.equal(selection?.timestamp, '19990101000000');
  assert.equal(selection?.fromExcludedCapture, true);
  assert.match(selection?.reason ?? '', /every capture of this URL failed statuscode:200/u);
});

test('a capture set with no usable timestamp selects nothing rather than guessing', () => {
  assert.equal(selectCapture([], NEAREST, null), null);
  assert.equal(selectCapture([capture('not-a-timestamp', 10)], NEAREST, null), null);
});

test('the default is nearest, and the policy set is closed', () => {
  assert.equal(DEFAULT_SELECTION.policy, 'nearest');
  assert.deepEqual([...CAPTURE_SELECTION_POLICIES], ['nearest', 'earliest-largest']);
});
