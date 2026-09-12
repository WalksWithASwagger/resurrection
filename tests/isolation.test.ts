/**
 * Network isolation, asserted structurally.
 *
 * The contract says tests run against deterministic local fixtures and that a
 * live provider call is a separate human-approved action
 * (agentic/contract.json, safety.network_isolation). A green suite is not by
 * itself evidence of that: these checks pin where the network boundary lives
 * and prove the suite never crosses it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TESTS = fileURLToPath(new URL('.', import.meta.url));

/** The only two modules allowed to reference a networking primitive. */
const NETWORK_BOUNDARY = new Set(['transport.ts', 'destination.ts']);

const NETWORK_PRIMITIVES = [/node:https?/u, /node:dns/u, /\bfetch\s*\(/u, /node:net/u];

async function sourceFiles(directory: string, suffix = '.ts'): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(entry.parentPath, entry.name));
}

test('only the transport and the destination guard touch a networking primitive', async () => {
  for (const path of await sourceFiles(SRC)) {
    const name = path.slice(SRC.length);
    if (NETWORK_BOUNDARY.has(name)) continue;
    const source = await readFile(path, 'utf8');
    for (const primitive of NETWORK_PRIMITIVES) {
      assert.doesNotMatch(source, primitive, `${name} must not reach the network directly`);
    }
  }
});

test('the destination guard uses a networking module only to classify addresses', async () => {
  const source = await readFile(join(SRC, 'destination.ts'), 'utf8');

  // node:net is used for isIP, and node:dns only inside systemResolver, which
  // the fixture suite never calls.
  assert.match(source, /import \{ isIP \} from 'node:net'/u);
  assert.equal(source.split("import('node:dns/promises')").length - 1, 1);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
});

test('classification and reclassification cannot refetch, because neither holds a transport', async () => {
  // Issue #5 requires that reclassifying an existing collection costs zero
  // refetches. A counter can show that a given run made none; this shows the
  // pass has nothing to make one with.
  for (const name of ['classify.ts', 'reclassify.ts']) {
    const source = await readFile(join(SRC, name), 'utf8');
    assert.doesNotMatch(source, /\bHttpTransport\b|\bfetchResource\b|\bcreateLiveTransport\b/u, `${name} must not fetch`);
  }
});

test('no test constructs the live transport or the system resolver', async () => {
  for (const path of await sourceFiles(TESTS)) {
    if (path.endsWith('isolation.test.ts')) continue;
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /createLiveTransport/u, `${path} must not build the live transport`);
    assert.doesNotMatch(source, /systemResolver/u, `${path} must not use the system resolver`);
  }
});

test('no fixture names a real pilot domain, a credential or a private collection', async () => {
  const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
  for (const path of await sourceFiles(fixtureRoot, '.json')) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /uncleweed|spark-online/iu, `${path} must not name a pilot domain`);
    assert.doesNotMatch(source, /(?:api[_-]?key|secret|password|access[_-]?token|Authorization)/iu);
    // Every fixture host is the archive provider or under the reserved
    // .invalid TLD, so nothing in the manifest can resolve to a real service.
    for (const url of source.match(/https?:\/\/[^"\s\\]+/gu) ?? []) {
      const hostname = new URL(url.replace(/\\{1,2}\//gu, '/')).hostname;
      assert.ok(
        hostname.endsWith('.invalid') || hostname.endsWith('web.archive.org'),
        `${path} refers to ${hostname}, which is neither the provider nor a reserved test host`,
      );
    }
  }
});
