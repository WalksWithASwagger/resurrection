import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { createLiveTransport } from '../src/transport.ts';

test('the live adapter fetches bytes from the pinned address for the requested host', async () => {
  const server = createServer((request, response) => {
    response.end(`${request.headers.host}${request.url}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = new URL('http://archive.invalid/fixture?item=1');
    url.port = String(address.port);
    const result = await createLiveTransport()(
      { url: url.href },
      { pinnedAddresses: ['127.0.0.1'], timeoutMs: 2000, maxBytes: 1024 },
    );
    assert.equal(result.status, 200);
    assert.equal(Buffer.from(result.body).toString(), url.host + url.pathname + url.search);
    assert.equal(result.truncated, false);
  } finally {
    await server[Symbol.asyncDispose]();
  }
});
