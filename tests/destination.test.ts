import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blockedAddressReason,
  checkDestination,
  DEFAULT_ALLOWED_PORTS,
  type DestinationPolicy,
  type DnsResolver,
} from '../src/index.ts';

const OPEN: DestinationPolicy = { allowedHosts: [], allowedPorts: DEFAULT_ALLOWED_PORTS };
const ARCHIVE_ONLY: DestinationPolicy = {
  allowedHosts: ['web.archive.org'],
  allowedPorts: DEFAULT_ALLOWED_PORTS,
};

function resolverFor(map: Record<string, string[]>): DnsResolver {
  return async (hostname) => {
    const addresses = map[hostname];
    if (addresses === undefined) throw new Error(`no fixture address for ${hostname}`);
    return addresses;
  };
}

const neverResolves: DnsResolver = async (hostname) => {
  throw new Error(`resolution was attempted for ${hostname}, which this test forbids`);
};

test('literal private, loopback and link-local addresses are refused', async () => {
  const cases = [
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://192.168.0.1/x',
    'http://172.16.9.9/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x',
    'http://[fd00::1]/x',
    'http://[fe80::1]/x',
  ];
  for (const url of cases) {
    const decision = await checkDestination(url, OPEN, neverResolves);
    assert.equal(decision.allowed, false, `${url} should be refused`);
  }
});

test('an IPv4-mapped IPv6 literal cannot smuggle a loopback address past the check', async () => {
  const decision = await checkDestination('http://[::ffff:127.0.0.1]/x', OPEN, neverResolves);

  assert.equal(decision.allowed, false);
  assert.match(decision.allowed === false ? decision.reason : '', /loopback/u);
});

test('a hostname that resolves to a private address is refused', async () => {
  const decision = await checkDestination(
    'https://evil.web.archive.org/web/1999/http://demo.invalid/',
    ARCHIVE_ONLY,
    resolverFor({ 'evil.web.archive.org': ['10.0.0.7'] }),
  );

  assert.equal(decision.allowed, false);
  assert.match(decision.allowed === false ? decision.reason : '', /10\.0\.0\.7.*private/u);
});

test('any private address among several refuses the whole hostname', async () => {
  const decision = await checkDestination(
    'https://web.archive.org/x',
    ARCHIVE_ONLY,
    resolverFor({ 'web.archive.org': ['203.0.113.10', '169.254.169.254'] }),
  );

  assert.equal(decision.allowed, false);
});

test('a host outside the provider allowlist is refused before any resolution', async () => {
  const decision = await checkDestination('https://demo.invalid/live-origin', ARCHIVE_ONLY, neverResolves);

  assert.equal(decision.allowed, false);
  assert.match(decision.allowed === false ? decision.reason : '', /not an allowed provider host/u);
});

test('non-http schemes, embedded credentials and odd ports are refused', async () => {
  const refusals = [
    'file:///etc/passwd',
    'https://user:secret@web.archive.org/x',
    'https://web.archive.org:8443/x',
  ];
  for (const url of refusals) {
    const decision = await checkDestination(url, ARCHIVE_ONLY, neverResolves);
    assert.equal(decision.allowed, false, `${url} should be refused`);
  }
});

test('a public provider address is allowed and its addresses are returned for pinning', async () => {
  const decision = await checkDestination(
    'https://web.archive.org/cdx/search/cdx?url=demo.invalid',
    ARCHIVE_ONLY,
    resolverFor({ 'web.archive.org': ['203.0.113.10'] }),
  );

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.allowed === true ? decision.addresses : [], ['203.0.113.10']);
});

test('address classification names the range it refused', () => {
  assert.match(blockedAddressReason('169.254.169.254') ?? '', /link-local/u);
  assert.match(blockedAddressReason('100.100.0.1') ?? '', /carrier-grade NAT/u);
  assert.equal(blockedAddressReason('203.0.113.10'), null);
});
