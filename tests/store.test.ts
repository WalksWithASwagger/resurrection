import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { BodyStore, sha256 } from '../src/index.ts';
import { withTempDirectory } from './helpers/acquisition.ts';

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

test('a body is addressed by the hash of exactly the bytes that arrived', async () => {
  await withTempDirectory(async (directory) => {
    const store = new BodyStore(join(directory, 'store'));
    const body = bytes('<html><body>demo</body></html>');

    const stored = await store.put(body);

    assert.equal(stored.hash, sha256(body));
    assert.equal(stored.byteLength, body.length);
    assert.equal(stored.deduplicated, false);
    assert.deepEqual(await store.read(stored.hash), body);
  });
});

test('identical bytes from two URLs are stored once and both records survive', async () => {
  await withTempDirectory(async (directory) => {
    const store = new BodyStore(join(directory, 'store'));
    const body = bytes('shared spacer gif');

    const first = await store.put(body);
    const second = await store.put(body);

    assert.equal(first.hash, second.hash);
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
  });
});

test('the stored path is relative, so a report can be moved off this machine', async () => {
  await withTempDirectory(async (directory) => {
    const store = new BodyStore(join(directory, 'store'));

    const stored = await store.put(bytes('portable'));

    assert.match(stored.relativePath, /^objects\//u);
    assert.doesNotMatch(stored.relativePath, /^\//u);
    assert.ok(stored.relativePath.endsWith(stored.hash));
  });
});

test('an absent hash reads as absent rather than as empty content', async () => {
  await withTempDirectory(async (directory) => {
    const store = new BodyStore(join(directory, 'store'));

    assert.equal(await store.has(sha256(bytes('never stored'))), false);
  });
});
